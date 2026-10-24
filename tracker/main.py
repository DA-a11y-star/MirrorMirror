"""Run: python tracker/main.py. Serves only the local browser; no relay or UI required."""

import argparse
import asyncio
import json
from pathlib import Path
import sys
import threading
import time

# Support the command in CLAUDE.md as well as `python -m tracker.main`.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State

from tracker.capture import CameraCapture, LatestValue
from tracker.gestures import PinchEvents
from tracker.hands import MODEL_PATH, HandFrames, ensure_model
from tracker.gaze import GazeWorker, PROVIDERS

STALE_SECONDS = 0.5


class TrackingWorker:
    def __init__(self, camera):
        self.camera = camera
        self.frames = LatestValue()
        self.stop_event = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self._run, name="hand-inference", daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=2)

    def _run(self):
        try:
            import cv2
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions, vision

            ensure_model()
            options = vision.HandLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(MODEL_PATH)),
                running_mode=vision.RunningMode.VIDEO,
                num_hands=2,
                # Slightly permissive: motion blur drops confidence first, and losing the hand forces the much
                # slower full-frame palm detector. The One Euro filter absorbs the extra jitter.
                min_hand_detection_confidence=0.5,
                min_hand_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            adapter = HandFrames()
            version, last_ts_ms = 0, -1
            # Console diagnostics every 2 s: where hand frames are being lost between camera and landmarker.
            stats = dict(since=time.monotonic(), cam_frames=0, done=0, stale=0, ms=[], seen=0, held=0)
            with vision.HandLandmarker.create_from_options(options) as landmarker:
                while not self.stop_event.is_set():
                    new_version, captured = self.camera.frames.get(after=version, timeout=0.1)
                    if new_version == version or captured is None:
                        continue
                    stats["cam_frames"] += new_version - version
                    version = new_version
                    observed_at, frame = captured
                    if time.monotonic() - observed_at > STALE_SECONDS:
                        stats["stale"] += 1
                        continue
                    frame = cv2.flip(frame, 1)
                    h, w = frame.shape[:2]
                    ts_ms = max(int(observed_at * 1000), last_ts_ms + 1)
                    last_ts_ms = ts_ms
                    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                    started = time.monotonic()
                    result = landmarker.detect_for_video(image, ts_ms)
                    infer_ms = (time.monotonic() - started) * 1000
                    packet = adapter.update(result, observed_at, w, h)
                    packet["infer_ms"] = round(infer_ms, 1)
                    self.frames.put(packet)
                    stats["done"] += 1
                    stats["ms"].append(infer_ms)
                    stats["seen"] += len(result.hand_landmarks)
                    stats["held"] += sum(h["held"] for h in packet["hands"])
                    elapsed = time.monotonic() - stats["since"]
                    if elapsed >= 2:
                        ms = sorted(stats["ms"])
                        print(f"[hands] camera {stats['cam_frames'] / elapsed:.0f} fps, inferred {stats['done'] / elapsed:.0f} Hz "
                              f"(stale-dropped {stats['stale']}), detect median {ms[len(ms) // 2]:.0f} ms max {ms[-1]:.0f} ms, "
                              f"hands detected {stats['seen']}/{stats['done']} frames, held {stats['held']}", flush=True)
                        stats.update(since=time.monotonic(), cam_frames=0, done=0, stale=0, ms=[], seen=0, held=0)
        except Exception as exc:
            self.error = exc


class TrackerServer:
    def __init__(self, frames, gaze=None):
        self.frames = frames
        self.gaze = gaze

    async def handle(self, websocket):
        version = 0
        gestures = PinchEvents()
        try:
            while websocket.state is State.OPEN:
                # Wake the moment inference publishes a frame instead of polling on a 1/60 s timer.
                new_version, frame = await asyncio.to_thread(self.frames.get, version, 0.05)
                if new_version != version and frame is not None and time.monotonic() - frame["t"] <= STALE_SECONDS:
                    version = new_version
                    if self.gaze is not None:
                        sensed = self.gaze.latest()
                        # Head pose rides in the gaze result (same face model) but has its own frame field.
                        frame = {**frame, "gaze": {k: v for k, v in sensed.items() if k != "head"},
                                 "head": sensed.get("head")}
                    messages = [frame, *gestures.update(frame["hands"])]
                    # One slow browser cannot stall capture, inference, or another browser.
                    for message in messages:
                        await asyncio.wait_for(websocket.send(json.dumps(message, allow_nan=False)), timeout=1)
        except ConnectionClosed:
            pass
        except TimeoutError:
            await websocket.close(code=1013, reason="Tracker client is too slow")


async def run(camera_index=0, port=8766, gaze_source="webcam"):
    camera = CameraCapture(camera_index)
    worker = TrackingWorker(camera)
    gaze = GazeWorker(camera, gaze_source) if gaze_source != "none" else None
    server = TrackerServer(worker.frames, gaze)
    async with serve(server.handle, "localhost", port, compression=None, close_timeout=1):
        print(f"Tracker listening on ws://localhost:{port}; Ctrl+C to stop.", flush=True)
        camera.start()
        worker.start()
        if gaze is not None:
            gaze.start()
        try:
            while True:
                if camera.error is not None:
                    raise camera.error
                if worker.error is not None:
                    raise worker.error
                await asyncio.sleep(0.1)
        finally:
            worker.stop_event.set()
            camera.stop_event.set()
            if gaze is not None:
                await asyncio.to_thread(gaze.stop)
            await asyncio.to_thread(worker.stop)
            await asyncio.to_thread(camera.stop)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0, help="OpenCV camera index (default: 0)")
    parser.add_argument("--port", type=int, default=8766, help="Local WebSocket port (default: 8766)")
    parser.add_argument("--gaze", choices=[*PROVIDERS, "none"], default="webcam",
                        help="Gaze provider; 'none' runs only the accepted hand tracker")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.camera, args.port, args.gaze))
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        raise SystemExit(f"Tracker stopped: {exc}") from exc


if __name__ == "__main__":
    main()
