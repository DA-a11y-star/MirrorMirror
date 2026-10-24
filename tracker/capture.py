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
    def __init__(self, index=0):
        self.index = index
        self.frames = LatestValue()
        self.stop_event = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self._run, name="camera-capture", daemon=True)

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
                    raise RuntimeError("Cannot open webcam. Check camera permissions and close other camera apps.")
                self.stop_event.wait(1)
            if self.stop_event.is_set():
                return
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_SIZE[0])
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_SIZE[1])
            cap.set(cv2.CAP_PROP_FPS, 30)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            print("Camera open; streaming hands to the local browser.", flush=True)
            while not self.stop_event.is_set():
                ok, frame = cap.read()
                if not ok:
                    raise RuntimeError("Webcam stopped returning frames. Restart the tracker to reconnect.")
                self.frames.put((time.monotonic(), frame))
        except Exception as exc:
            self.error = exc
        finally:
            if cap is not None:
                cap.release()
