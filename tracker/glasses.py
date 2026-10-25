"""Marker-assisted glasses gaze observations (2D prototype, not a metric eye model).

The browser renders IDs 10..13 and sends their normalized viewport corners.
Inspect a local eye snapshot: python -m tracker.glasses --inspect eye.jpg --overlay detection.jpg
"""

import argparse
import json
from collections import deque
from pathlib import Path
import threading
import time

import cv2
import numpy as np

from tracker.capture import LatestValue

MAX_SKEW = .075  # arrival-time alignment, not exposure synchronization
MAX_AGE = .15
LAYOUT_SETTLE = .25  # discard in-flight frames after browser resize/reconnect


def valid_screen_layout(value):
    """Validate the small browser-to-local-tracker geometry message."""
    if not isinstance(value, dict) or value.get('version') != 1:
        return None
    name, width, height, markers = (value.get(key) for key in ('id', 'width', 'height', 'markers'))
    if not isinstance(name, str) or not 1 <= len(name) <= 96:
        return None
    if not all(isinstance(v, (float, int)) and np.isfinite(v) and 160 <= v <= 32768 for v in (width, height)):
        return None
    if not isinstance(markers, list) or len(markers) != 4:
        return None
    cleaned = []
    for i, marker in enumerate(markers):
        if not isinstance(marker, dict) or marker.get('id') != 10 + i:
            return None
        try:
            corners = np.asarray(marker.get('corners'), dtype=float)
        except (TypeError, ValueError):
            return None
        if corners.shape != (4, 2) or not np.isfinite(corners).all() or np.any(corners < 0) or np.any(corners > 1):
            return None
        x0, y0 = corners[0]
        x1, y1 = corners[2]
        if not (.005 < x1 - x0 < .3 and .005 < y1 - y0 < .3):
            return None
        if not np.allclose(corners, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], atol=1e-9):
            return None
        if abs((x1 - x0) * width - (y1 - y0) * height) > 2:
            return None
        cleaned.append(dict(id=10 + i, corners=corners.tolist()))
    centers = np.array([np.mean(marker['corners'], axis=0) for marker in cleaned])
    if not (centers[0, 0] < centers[1, 0] and centers[3, 0] < centers[2, 0] and
            centers[0, 1] < centers[3, 1] and centers[1, 1] < centers[2, 1]):
        return None
    return dict(version=1, id=name, width=width, height=height, markers=cleaned)


class ObservationHistory:
    """Small thread-safe history; no image backlog and no unbounded waiting."""

    def __init__(self, capacity=16):
        self.values = deque(maxlen=capacity)
        self.lock = threading.Lock()

    def put(self, t, value):
        with self.lock:
            self.values.append((t, value))

    def clear(self):
        with self.lock:
            self.values.clear()

    def nearest(self, t, now, max_skew=MAX_SKEW):
        with self.lock:
            if not self.values:
                return None
            stamp, value = min(self.values, key=lambda sample: abs(sample[0] - t))
        # A failed detection is also an observation: never skip it to reuse an older valid pose.
        if abs(stamp - t) > max_skew or now - stamp > MAX_AGE or now - t > MAX_AGE:
            return None
        return stamp, value


def detect_pupil(image, roi=None, diagnostics=None):
    """Dark-pupil ellipse detector. ROI is normalized [x, y, width, height].

    No face landmarks: this camera sees one eye, not a complete face. Reject weak
    contrast, clipped contours and non-elliptical dark regions instead of guessing.
    """
    height, width = image.shape[:2]
    x, y, w, h = roi or (0, 0, 1, 1)
    x0, y0 = int(x * width), int(y * height)
    crop = image[y0:int((y + h) * height), x0:int((x + w) * width)]
    if crop.size == 0:
        return None
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    ch, cw = gray.shape
    if float(np.percentile(gray, 80) - np.percentile(gray, 2)) < 18:
        return None
    candidates = []
    for percentile in (1, 3, 6, 10, 16, 23):
        threshold = min(float(np.percentile(gray, percentile)) + 5, float(np.percentile(gray, 65)) - 15)
        mask = (gray < threshold).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        for contour in contours:
            if len(contour) < 12:
                continue
            area = cv2.contourArea(contour)
            if not .001 * cw * ch < area < .16 * cw * ch:
                continue
            bx, by, bw, bh = cv2.boundingRect(contour)
            if bx <= 1 or by <= 1 or bx + bw >= cw - 1 or by + bh >= ch - 1:
                continue
            ellipse = cv2.fitEllipse(contour)
            (cx, cy), (a, b), angle = ellipse
            if min(a, b) < 4 or min(a, b) / max(a, b) < .3:
                continue
            fill = area / (np.pi * a * b / 4)
            if not .7 < fill < 1.25:
                continue
            inner = np.zeros_like(gray)
            cv2.ellipse(inner, ellipse, 255, -1)
            outer = cv2.dilate(inner, np.ones((15, 15), np.uint8))
            ring = (outer > 0) & (inner == 0)
            if not ring.any():
                continue
            contrast = float(gray[ring].mean() - gray[inner > 0].mean())
            if contrast < 15:
                continue
            score = contrast * min(fill, 1 / fill) * np.sqrt(area)
            candidates.append(dict(center=[cx + x0, cy + y0], axes=[a, b], angle=angle, area=area,
                                   threshold=threshold, contrast=contrast, score=float(score),
                                   darkness=float(np.median(gray[inner > 0]))))
    # A larger iris can have stronger sclera contrast than the actual pupil. When
    # a substantially darker, nested pupil ellipse exists, do not reward the iris
    # merely for its area. This was observable on the mounted live camera.
    for outer in candidates:
        outer['iris'] = any(
            .08 * outer['area'] < inner['area'] < .6 * outer['area'] and
            inner['darkness'] + 8 < outer['darkness'] and
            np.linalg.norm(np.array(inner['center']) - outer['center']) < .35 * min(outer['axes'])
            for inner in candidates)
    if diagnostics is not None:
        diagnostics.extend(candidates)
    pupils = [candidate for candidate in candidates if not candidate['iris']]
    if not pupils:
        return None
    best = max(pupils, key=lambda candidate: candidate['score'])
    cx, cy = best['center']
    u, v = cx / width, cy / height
    return dict(features=[u, v, u * v, u * u - v * v],
                ellipse=((cx, cy), tuple(best['axes']), best['angle']),
                conf=min(.95, .55 + best['contrast'] / 255))


def screen_homography(corners, ids, width, height, layout=None):
    """Normalized scene image -> browser viewport using all 16 known corners."""
    if ids is None or layout is None:
        return None
    identifiers = np.asarray(ids).ravel().tolist()
    wanted = range(10, 14)
    if any(identifiers.count(i) != 1 for i in wanted):
        return None
    by_id = {int(i): np.asarray(c).reshape(4, 2) for c, i in zip(corners, identifiers)}
    if not all(i in by_id for i in wanted):
        return None
    source = np.float32(np.concatenate([by_id[i] for i in wanted]) / [width, height])
    target = np.float32(np.concatenate([marker['corners'] for marker in layout['markers']]))
    centers = np.float32([by_id[i].mean(axis=0) for i in wanted])
    if not cv2.isContourConvex(centers.reshape(-1, 1, 2)) or cv2.contourArea(centers, oriented=True) <= 0:
        return None
    matrix, _ = cv2.findHomography(source, target, method=0)
    if matrix is None or not np.isfinite(matrix).all() or np.linalg.cond(matrix) > 1e5:
        return None
    # Sixteen corners constrain a single screen plane, not four marker centers
    # incorrectly assumed to be display corners. Reject inconsistent geometry.
    reprojected = cv2.perspectiveTransform(target.reshape(-1, 1, 2), np.linalg.inv(matrix)).reshape(-1, 2)
    error = np.linalg.norm((reprojected - source) * [width, height], axis=1)
    if np.max(error) > max(3, .003 * max(width, height)):
        return None
    return matrix.ravel().tolist()


class GlassesWorker:
    def __init__(self, eye, scene, head=None, roi=None):
        if not hasattr(cv2, "aruco"):
            raise RuntimeError("Install opencv-contrib-python>=4.8 for screen-marker detection")
        self.eye, self.scene, self.head, self.roi = eye, scene, head, roi
        self.frames, self.preview, self.screen_preview = LatestValue(), LatestValue(), LatestValue()
        self.poses = ObservationHistory()
        self.stop_event = threading.Event()
        self.error = None
        self.layout_lock = threading.Lock()
        self.layout, self.layout_owner, self.layout_changed_at = None, None, 0
        self.threads = [threading.Thread(target=self._scene_loop, name="screen-markers", daemon=True),
                        threading.Thread(target=self._eye_loop, name="pupil-tracking", daemon=True)]

    def start(self):
        for thread in self.threads:
            thread.start()

    def stop(self):
        self.stop_event.set()
        for thread in self.threads:
            thread.join(timeout=2)

    def set_screen_layout(self, value, owner=None):
        if value is None:
            self.release_screen_layout(owner)
            return True
        layout = valid_screen_layout(value)
        if layout is None:
            return False
        with self.layout_lock:
            self.layout, self.layout_owner = layout, owner
            self.layout_changed_at = time.monotonic()
            self.poses.clear()
        return True

    def release_screen_layout(self, owner):
        with self.layout_lock:
            if self.layout_owner is owner:
                self.layout, self.layout_owner = None, None
                self.poses.clear()

    def screen_layout(self):
        with self.layout_lock:
            return self.layout, self.layout_changed_at

    def _scene_loop(self):
        try:
            detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50))
            version = 0
            while not self.stop_event.is_set():
                new_version, captured = self.scene.frames.get(after=version, timeout=.05)
                if version == new_version or captured is None:
                    continue
                version = new_version
                t, image = captured
                if time.monotonic() - t > MAX_AGE:
                    continue
                corners, ids, _ = detector.detectMarkers(image)
                h, w = image.shape[:2]
                layout, changed_at = self.screen_layout()
                matrix = screen_homography(corners, ids, w, h, layout=layout)
                if layout and t < changed_at + LAYOUT_SETTLE:
                    matrix = None
                self.poses.put(t, dict(matrix=matrix, layout=layout['id'] if layout else None,
                                       markers=ids.ravel().tolist() if ids is not None else []))
                overlay = image.copy()
                if ids is not None:
                    cv2.aruco.drawDetectedMarkers(overlay, corners, ids)
                self.screen_preview.put(overlay)
        except Exception as exc:
            self.error = exc

    def _eye_loop(self):
        try:
            version = 0
            while not self.stop_event.is_set():
                new_version, captured = self.eye.frames.get(after=version, timeout=.05)
                if version == new_version or captured is None:
                    continue
                version = new_version
                t, image = captured
                pupil = detect_pupil(image, self.roi)
                matched = self.poses.nearest(t, time.monotonic())
                pose = matched[1] if matched else {}
                layout, _ = self.screen_layout()
                layout_id = layout['id'] if layout else None
                matrix = pose.get('matrix') if pose.get('layout') == layout_id else None
                marker_ids = pose.get('markers', [])
                wanted = range(10, 14)
                seen = len(set(marker_ids).intersection(wanted))
                valid = pupil is not None and matrix is not None
                status = "glasses ready: calibrate gaze" if valid else (
                    "pupil not visible: check eye ROI, focus or blink" if pupil is None else
                    f"screen markers {seen}/4: keep browser markers visible; waiting for a fresh screen reference")
                packet = dict(source="glasses", t=t, conf=pupil['conf'] if valid else 0,
                              features=pupil['features'] if pupil else None,
                              screen=matrix, status=status,
                              screen_layout=layout_id, marker_ids=marker_ids,
                              pupil_conf=pupil['conf'] if pupil else 0,
                              sync_ms=round(abs(t - matched[0]) * 1000, 1) if matched else None)
                self.frames.put(packet)
                overlay = image.copy()
                if self.roi:
                    h, w = overlay.shape[:2]
                    x, y, rw, rh = self.roi
                    cv2.rectangle(overlay, (round(x * w), round(y * h)),
                                  (round((x + rw) * w), round((y + rh) * h)), (255, 220, 0), 1)
                if pupil:
                    cv2.ellipse(overlay, pupil['ellipse'], (0, 255, 0), 2)
                cv2.putText(overlay, status, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, .45, (0, 220, 255), 1)
                self.preview.put(overlay)
        except Exception as exc:
            self.error = exc

    def latest(self):
        errors = [self.error, self.eye.error, self.scene.error]
        error = next((error for error in errors if error is not None), None)
        _, packet = self.frames.get()
        if error is not None or packet is None or time.monotonic() - packet['t'] > MAX_AGE:
            layout, _ = self.screen_layout()
            packet = dict(source="glasses", conf=0, t=time.monotonic(),
                          screen_layout=layout['id'] if layout else None,
                          status=f"glasses error: {error}" if error else "waiting for fresh glasses frames")
        if self.head is not None:
            packet = {**packet, "head": self.head.latest().get('head')}
        return packet


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', type=Path, required=True, help='Inspect pupil detection on a local diagnostic snapshot')
    parser.add_argument('--overlay', type=Path, help='Save the annotated pupil inspection image')
    parser.add_argument('--eye-roi', type=float, nargs=4)
    parser.add_argument('--candidates', action='store_true', help='Include candidate ellipse diagnostics')
    args = parser.parse_args()
    image = cv2.imread(str(args.inspect))
    if image is None:
        parser.error('Cannot open diagnostic image')
    diagnostics = [] if args.candidates else None
    pupil = detect_pupil(image, args.eye_roi, diagnostics=diagnostics)
    print(json.dumps(dict(pupil=pupil, candidates=diagnostics) if args.candidates else pupil, indent=2))
    if args.overlay:
        if pupil:
            cv2.ellipse(image, pupil['ellipse'], (0, 255, 0), 2)
        if not cv2.imwrite(str(args.overlay), image):
            parser.error('Cannot write diagnostic overlay')
