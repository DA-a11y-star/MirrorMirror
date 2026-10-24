"""Replaceable gaze providers. Webcam iris features are calibrated to screen coordinates in web/gaze.js.

A hardware provider can return {source, x, y, conf, t} in normalized viewport coordinates instead.
Implement process(bgr_frame, observed_at) and close(), then register the provider below.
"""

import math
import ssl
import threading
import time
import urllib.request
from pathlib import Path

import certifi
import cv2
import numpy as np

from tracker.capture import LatestValue
from tracker.filters import OneEuroFilter
from tracker.hands import CAMERA_HFOV_DEG

EYE_SPAN_M = 0.063  # typical interpupillary distance
MIN_EYE_SPAN_PX = 12
YAW_LIMIT = 0.8  # past ~53 degrees of head turn the foreshortening correction is too unreliable to apply
HEAD_RANGE_M = (0.2, 1.5)  # plausible webcam-to-face distances; anything else is a misdetection

FACE_MODEL = Path(__file__).resolve().parent.parent / "face_landmarker.task"
FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
GAZE_MAX_AGE = 0.25


def ensure_face_model():
    if FACE_MODEL.exists():
        return
    print("Downloading the webcam gaze model (once, ~3.8 MB) ...", flush=True)
    temporary = FACE_MODEL.with_suffix(".download")
    try:
        context = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(FACE_MODEL_URL, context=context, timeout=30) as response:
            temporary.write_bytes(response.read())
        temporary.replace(FACE_MODEL)
    finally:
        temporary.unlink(missing_ok=True)


def eye_features(landmarks, w, h):
    """Iris displacement in each eye's local frame + nose offset as a head-pose covariate.

    Iris geometry alone is not an absolute gaze measurement. Per-user screen calibration is required.
    Reject closed/occluded eyes rather than letting a blink select a random block.
    """
    if len(landmarks) < 478:
        return None
    points = np.array([[p.x * w, p.y * h] for p in landmarks])
    if not np.isfinite(points).all():
        return None
    eyes, centers = [], []
    for a, b, top, bottom, iris in [(33, 133, 159, 145, 468), (362, 263, 386, 374, 473)]:
        left, right = sorted((points[a], points[b]), key=lambda p: p[0])
        axis = right - left
        width = float(np.linalg.norm(axis))
        if width < 8:
            return None
        axis /= width
        down = np.array([-axis[1], axis[0]])
        aperture = abs(float(np.dot(points[bottom] - points[top], down))) / width
        if aperture < 0.12:
            return None
        center = (left + right) / 2
        offset = points[iris] - center
        horizontal = float(np.dot(offset, axis) / width)
        vertical = float(np.dot(offset, down) / width)
        if abs(horizontal) > .65 or abs(vertical) > .4:
            return None
        eyes.append([horizontal, vertical])
        centers.append(center)
    span = float(np.linalg.norm(centers[1] - centers[0]))
    if span < 20:
        return None
    nose = (points[1] - np.mean(centers, axis=0)) / span
    return [*np.mean(eyes, axis=0).tolist(), *nose.tolist()]


def head_position(landmarks, w, h, yaw_axis_z=0.0):
    """Midpoint between the eyes in webcam space: meters, x toward the user's right (the frame is mirrored),
    y down, z = distance from the webcam. None if the face is too small or degenerate to measure.

    Distance comes from the pixel gap between the two eye centers versus a typical 63 mm interpupillary distance,
    so it is an estimate (a few cm of error for a different face), but its changes are what drive parallax.
    yaw_axis_z is the z component of the head's left-right axis (0 when facing the camera): turning the head
    shrinks the pixel gap, which would otherwise read as moving away.

    Unlike eye_features this ignores blinks: closed eyes still have measurable corners.
    """
    if len(landmarks) < 468:
        return None
    points = np.array([[p.x * w, p.y * h] for p in landmarks[:468]])
    if not np.isfinite(points).all():
        return None
    centers = [(points[a] + points[b]) / 2 for a, b in [(33, 133), (362, 263)]]
    span = float(np.linalg.norm(centers[1] - centers[0])) / math.sqrt(1 - min(abs(yaw_axis_z), YAW_LIMIT) ** 2)
    if span < MIN_EYE_SPAN_PX:
        return None
    focal = (w / 2) / math.tan(math.radians(CAMERA_HFOV_DEG) / 2)
    z = focal * EYE_SPAN_M / span
    if not HEAD_RANGE_M[0] <= z <= HEAD_RANGE_M[1]:
        return None
    mid = (centers[0] + centers[1]) / 2
    return [float((mid[0] - w / 2) / focal * z), float((mid[1] - h / 2) / focal * z), float(z)]


def head_rotation(matrix):
    """Unit quaternion [x, y, z, w] in the same frame as head_position, from MediaPipe's face transform
    (OpenGL-style camera: y up, camera looks down -z), plus the z component of the head's left-right axis."""
    m = np.asarray(matrix, dtype=float)[:3, :3]
    flip = np.diag([1., -1., -1.])  # to x right, y down, z away
    r = flip @ (m / np.cbrt(abs(np.linalg.det(m)) or 1.0)) @ flip
    trace = r[0, 0] + r[1, 1] + r[2, 2]
    if trace > 0:
        s = 2 * math.sqrt(trace + 1)
        q = [(r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, s / 4]
    else:
        i = int(np.argmax(np.diag(r)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = 2 * math.sqrt(1 + r[i, i] - r[j, j] - r[k, k])
        q = [0., 0., 0., (r[k, j] - r[j, k]) / s]
        q[i] = s / 4
        q[j] = (r[j, i] + r[i, j]) / s
        q[k] = (r[k, i] + r[i, k]) / s
    q = np.array(q) / np.linalg.norm(q)
    return q.tolist(), float(r[2, 0])


class WebcamGaze:
    def __init__(self):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        ensure_face_model()
        self.mp = mp
        self.last_ts = -1
        # Heavy smoothing: eye-gap pixel noise is amplified by the parallax gain, and any lag here is small
        # next to the face model's own ~50-80 ms.
        self.head_filter = OneEuroFilter(min_cutoff=.6, beta=4.0)
        self.landmarker = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(FACE_MODEL)),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=1,
            min_face_detection_confidence=.6,
            min_face_presence_confidence=.6,
            min_tracking_confidence=.6,
            output_facial_transformation_matrixes=True,
        ))

    def process(self, frame, observed_at):
        frame = cv2.flip(frame, 1)
        h, w = frame.shape[:2]
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        self.last_ts = max(self.last_ts + 1, int(observed_at * 1000))
        result = self.landmarker.detect_for_video(image, self.last_ts)
        face = result.face_landmarks[0] if result.face_landmarks else None
        features = eye_features(face, w, h) if face else None
        head = None
        if face:
            quat, yaw_axis_z = None, 0.0
            if result.facial_transformation_matrixes:
                quat, yaw_axis_z = head_rotation(result.facial_transformation_matrixes[0])
            pos = head_position(face, w, h, yaw_axis_z)
            if pos is not None:
                head = dict(pos=[round(v, 4) for v in self.head_filter(pos, observed_at)],
                            quat=[round(v, 4) for v in quat] if quat else [0., 0., 0., 1.])
        if head is None:
            self.head_filter.reset()  # re-acquire from the first new reading instead of easing across a gap
        # conf is a geometry-validity heuristic, not a model probability or a calibrated accuracy score.
        return dict(source="webcam", x=None, y=None, conf=.8 if features else 0.0, features=features, head=head,
                    t=observed_at, status="eyes visible" if features else "face/eyes not visible or blinking")

    def close(self):
        self.landmarker.close()


PROVIDERS = {"webcam": WebcamGaze}


class GazeWorker:
    """Read the same latest camera slot at up to 20 Hz, independently of hand inference."""

    def __init__(self, camera, source="webcam"):
        self.camera, self.source = camera, source
        self.frames = LatestValue()
        self.stop_event = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self._run, name="gaze-inference", daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=2)

    def _run(self):
        provider = None
        try:
            provider = PROVIDERS[self.source]()
            version = 0
            while not self.stop_event.is_set():
                new_version, captured = self.camera.frames.get(after=version, timeout=.1)
                if new_version == version or captured is None:
                    continue
                version = new_version
                observed_at, image = captured
                if time.monotonic() - observed_at > GAZE_MAX_AGE:
                    continue
                started = time.monotonic()
                self.frames.put(provider.process(image, observed_at))
                self.stop_event.wait(max(0, 1 / 20 - (time.monotonic() - started)))
        except Exception as exc:
            self.error = exc
            print(f"Gaze unavailable (hands remain active): {exc}", flush=True)
        finally:
            if provider is not None:
                provider.close()

    def latest(self):
        if self.error is not None:
            return dict(source=self.source, conf=0, status=f"gaze error: {self.error}")
        _, value = self.frames.get()
        if value is None:
            return dict(source=self.source, conf=0, status="starting gaze model")
        if time.monotonic() - value["t"] > GAZE_MAX_AGE:
            return dict(source=self.source, conf=0, status="gaze feed stale")
        return value
