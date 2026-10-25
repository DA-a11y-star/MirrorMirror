"""Run: python tracker/main.py. Serves only the local browser; no relay or UI required."""

import argparse
import asyncio
import contextlib
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

    async def receive_layouts(self, websocket):
        try:
            async for raw in websocket:
                if not isinstance(raw, str) or len(raw) > 8192:
                    continue
                try:
                    message = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if isinstance(message, dict) and message.get('type') == 'screen_layout':
                    self.gaze.set_screen_layout(message.get('layout'), owner=websocket)
        except ConnectionClosed:
            pass

    async def handle(self, websocket):
        version = 0
        gaze_timestamp = -1
        last_gaze_sent = 0
        layouts = asyncio.create_task(self.receive_layouts(websocket)) if hasattr(self.gaze, 'set_screen_layout') else None
        gestures = PinchEvents()
        try:
            while websocket.state is State.OPEN:
                # Wake the moment inference publishes a frame instead of polling on a 1/60 s timer.
                new_version, frame = await asyncio.to_thread(self.frames.get, version, 0.01 if self.gaze else 0.05)
                changed = new_version != version
                version = new_version
                if changed and frame is not None and time.monotonic() - frame["t"] <= STALE_SECONDS:
                    if self.gaze is not None:
                        sensed = self.gaze.latest()
                        # Head pose rides in the gaze result (same face model) but has its own frame field.
                        frame = {**frame, "gaze": {k: v for k, v in sensed.items() if k != "head"},
                                 "head": sensed.get("head")}
                    messages = [frame, *gestures.update(frame["hands"])]
                    # One slow browser cannot stall capture, inference, or another browser.
                    for message in messages:
                        await asyncio.wait_for(websocket.send(json.dumps(message, allow_nan=False)), timeout=1)
                # A gaze packet does not advance hand timestamps or synthesize hand frames.
                # This keeps a fast eye camera independent of MediaPipe hand inference.
                if self.gaze is not None and time.monotonic() - last_gaze_sent >= 1 / 60:
                    sensed = self.gaze.latest()
                    stamp = sensed.get('t')
                    if stamp is not None and stamp > gaze_timestamp:
                        gaze_timestamp = stamp
                        last_gaze_sent = time.monotonic()
                        message = dict(type="gaze", t=stamp,
                                       gaze={k: v for k, v in sensed.items() if k != 'head'},
                                       head=sensed.get('head'))
                        await asyncio.wait_for(websocket.send(json.dumps(message, allow_nan=False)), timeout=1)
        except ConnectionClosed:
            pass
        except TimeoutError:
            await websocket.close(code=1013, reason="Tracker client is too slow")
        finally:
            if layouts:
                layouts.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await layouts
                self.gaze.release_screen_layout(websocket)


async def run(camera_index=0, port=8766, gaze_source="webcam", *, eye_index=None, scene_index=None,
              eye_roi=None, preview=False, snapshot_dir=None):
    if snapshot_dir is not None and not Path(snapshot_dir).is_dir():
        raise ValueError('--snapshot-dir must name an existing local directory')
    assignments = {}
    if gaze_source == 'glasses':
        if eye_index is None and scene_index is None:
            from tracker.camera_setup import load_assignments
            assignments = load_assignments()
            camera_index = assignments['webcam']['index']
            eye_index, scene_index = assignments['eye']['index'], assignments['scene']['index']
            eye_roi = eye_roi if eye_roi is not None else assignments['eye'].get('roi')
        if eye_index is None or scene_index is None or len({camera_index, eye_index, scene_index}) != 3:
            raise ValueError("Specify three different indexes with --camera, --eye-camera and --scene-camera, or run camera_setup")
    def capture(role, index, **options):
        if role in assignments:
            from tracker.mac_capture import MacCameraCapture
            return MacCameraCapture(assignments[role]['uid'], role=role,
                                    rotation=assignments[role]['rotation'], **options)
        return CameraCapture(index, role=role, **options)

    camera = capture('webcam', camera_index)
    worker = TrackingWorker(camera)
    cameras, gazes = [camera], []
    if gaze_source == 'glasses':
        from tracker.glasses import GlassesWorker
        eye = capture('eye', eye_index, size=(640, 480), fps=60)
        scene = capture('scene', scene_index, size=(1280, 720), fps=30)
        cameras.extend([eye, scene])
        head = GazeWorker(camera, 'webcam')
        gaze = GlassesWorker(eye, scene, head=head, roi=eye_roi)
        gazes.extend([head, gaze])
    else:
        gaze = GazeWorker(camera, gaze_source) if gaze_source != "none" else None
        if gaze:
            gazes.append(gaze)
    server = TrackerServer(worker.frames, gaze)
    snapshot_versions, last_snapshot = {}, 0
    async with serve(server.handle, "localhost", port, compression=None, close_timeout=1):
        print(f"Tracker listening on ws://localhost:{port}; Ctrl+C to stop.", flush=True)
        for capture in cameras:
            capture.start()
        worker.start()
        for sensing in gazes:
            sensing.start()
        try:
            while True:
                if camera.error is not None:
                    raise camera.error
                if worker.error is not None:
                    raise worker.error
                if snapshot_dir is not None and gaze_source == 'glasses' and time.monotonic() - last_snapshot >= 1:
                    import cv2
                    for name, slot in [('eye', gaze.preview), ('scene', gaze.screen_preview)]:
                        version, image = slot.get()
                        if image is not None and snapshot_versions.get(name) != version:
                            if not cv2.imwrite(str(Path(snapshot_dir) / f'{name}-live.jpg'), image):
                                raise RuntimeError(f'Cannot save {name} diagnostic snapshot')
                            snapshot_versions[name] = version
                    last_snapshot = time.monotonic()
                if preview and gaze_source == 'glasses':
                    import cv2
                    _, eye_image = gaze.preview.get()
                    if eye_image is not None:
                        cv2.imshow('Glasses eye: green ellipse = pupil (Esc stops)', eye_image)
                    _, screen_image = gaze.screen_preview.get()
                    if screen_image is not None:
                        image = screen_image.copy()
                        cv2.putText(image, gaze.latest()['status'], (10, 30), cv2.FONT_HERSHEY_SIMPLEX,
                                    .55, (0, 220, 255), 1)
                        cv2.imshow('Glasses forward: keep all four markers visible', cv2.resize(image, (800, 450)))
                    if cv2.waitKey(1) & 0xff == 27:
                        break
                await asyncio.sleep(0.02 if preview else 0.1)
        finally:
            worker.stop_event.set()
            for capture in cameras:
                capture.stop_event.set()
            for sensing in reversed(gazes):
                await asyncio.to_thread(sensing.stop)
            await asyncio.to_thread(worker.stop)
            for capture in cameras:
                await asyncio.to_thread(capture.stop)
            if preview:
                import cv2
                cv2.destroyAllWindows()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", type=int, default=0, help="OpenCV camera index (default: 0)")
    parser.add_argument("--port", type=int, default=8766, help="Local WebSocket port (default: 8766)")
    parser.add_argument("--gaze", choices=[*PROVIDERS, "glasses", "none"], default="webcam",
                        help="Gaze provider; 'none' runs only the accepted hand tracker")
    parser.add_argument('--eye-camera', type=int, help='Eye camera index; omit to use saved device IDs')
    parser.add_argument('--scene-camera', type=int, help='Forward camera index; omit to use saved device IDs')
    parser.add_argument('--eye-roi', type=float, nargs=4, metavar=('X', 'Y', 'WIDTH', 'HEIGHT'),
                        help='Normalized eye crop, e.g. 0.2 0.2 0.6 0.6; excludes eyebrows and frame edges')
    parser.add_argument('--preview', action='store_true', help='Show glasses camera diagnostics on the main thread')
    parser.add_argument('--snapshot-dir', type=Path, help='Save latest eye/scene diagnostic overlays once per second to an existing local directory')
    args = parser.parse_args()
    if args.eye_roi:
        x, y, w, h = args.eye_roi
        if not (0 <= x < 1 and 0 <= y < 1 and w > 0 and h > 0 and x + w <= 1 and y + h <= 1):
            parser.error('--eye-roi must be a positive rectangle within normalized image bounds')
    try:
        asyncio.run(run(args.camera, args.port, args.gaze, eye_index=args.eye_camera,
                        scene_index=args.scene_camera, eye_roi=args.eye_roi, preview=args.preview,
                        snapshot_dir=args.snapshot_dir))
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        raise SystemExit(f"Tracker stopped: {exc}") from exc


if __name__ == "__main__":
    main()
