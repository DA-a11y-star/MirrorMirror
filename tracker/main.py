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
                min_hand_detection_confidence=0.6,
                min_hand_presence_confidence=0.6,
                min_tracking_confidence=0.6,
            )
            adapter = HandFrames()
            version, last_ts_ms = 0, -1
            with vision.HandLandmarker.create_from_options(options) as landmarker:
                while not self.stop_event.is_set():
                    new_version, captured = self.camera.frames.get(after=version, timeout=0.1)
                    if new_version == version or captured is None:
                        continue
                    version = new_version
                    observed_at, frame = captured
                    if time.monotonic() - observed_at > STALE_SECONDS:
                        continue
                    frame = cv2.flip(frame, 1)
                    h, w = frame.shape[:2]
                    ts_ms = max(int(observed_at * 1000), last_ts_ms + 1)
                    last_ts_ms = ts_ms
                    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                    result = landmarker.detect_for_video(image, ts_ms)
                    self.frames.put(adapter.update(result, observed_at, w, h))
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
                new_version, frame = self.frames.get()
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
                await asyncio.sleep(1 / 60)
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
