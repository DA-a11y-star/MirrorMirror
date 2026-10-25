"""Camera capture owns its thread; consumers always get the newest frame, never a backlog."""

import threading
import time

import cv2

from tracker.hands import CAPTURE_SIZE


class LatestValue:
    def __init__(self):
        self.condition = threading.Condition()
        self.version = 0
        self.value = None

    def put(self, value):
        with self.condition:
            self.version += 1
            self.value = value
            self.condition.notify_all()

    def get(self, after=None, timeout=0):
        with self.condition:
            if after is not None:
                self.condition.wait_for(lambda: self.version != after, timeout=timeout)
            return self.version, self.value


class CameraCapture:
    def __init__(self, index=0, *, role="webcam", size=CAPTURE_SIZE, fps=30, rotation=0):
        self.index = index
        self.role, self.size, self.fps, self.rotation = role, size, fps, rotation
        self.started_at = None
        self.count = 0
        self.frames = LatestValue()
        self.stop_event = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self._run, name=f"capture-{role}", daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=2)

    def _run(self):
        cap = None
        try:
            deadline = time.monotonic() + 30
            while not self.stop_event.is_set():
                cap = cv2.VideoCapture(self.index)
                if cap.isOpened():
                    break
                cap.release()
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"Cannot open {self.role} camera {self.index}. Check permissions and close other camera apps.")
                self.stop_event.wait(1)
            if self.stop_event.is_set():
                return
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.size[0])
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.size[1])
            cap.set(cv2.CAP_PROP_FPS, self.fps)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            print(f"[{self.role}] camera {self.index}: {int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))}x"
                  f"{int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))} @ {cap.get(cv2.CAP_PROP_FPS):.0f} fps", flush=True)
            self.started_at = time.monotonic()
            while not self.stop_event.is_set():
                ok, frame = cap.read()
                if not ok:
                    raise RuntimeError(f"{self.role} camera stopped returning frames. Restart the tracker to reconnect.")
                observed_at = time.monotonic()  # arrival time, not hardware exposure time
                if self.rotation:
                    frame = cv2.rotate(frame, {90: cv2.ROTATE_90_CLOCKWISE,
                                              180: cv2.ROTATE_180,
                                              270: cv2.ROTATE_90_COUNTERCLOCKWISE}[self.rotation])
                self.count += 1
                self.frames.put((observed_at, frame))
        except Exception as exc:
            self.error = exc
        finally:
            if cap is not None:
                cap.release()
