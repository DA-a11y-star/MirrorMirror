"""MediaPipe/solvePnP helpers shared with hand_mouse.py, plus a browser frame adapter."""

import math
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from tracker.filters import OneEuroFilter
from tracker.gestures import GestureState

MODEL_PATH = Path(__file__).resolve().parent.parent / "hand_landmarker.task"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/latest/hand_landmarker.task"
)
PALM = [0, 5, 9, 13, 17]
CAMERA_HFOV_DEG = 65.0
CAPTURE_SIZE = (640, 480)
HOLD_TIME = 0.35


def ensure_model():
    if not MODEL_PATH.exists():
        print(f"Downloading hand landmarker model to {MODEL_PATH} ...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)


def landmarks_to_array(hand_landmarks):
    return np.array([[lm.x, lm.y, lm.z] for lm in hand_landmarks], dtype=np.float64)


class HandTracker:
    """Keep the last observed pose through brief detection gaps, with its original timestamp."""

    def __init__(self):
        self.last = {}

    def update(self, res, now):
        live, seen = [], set()
        for lm, world, handedness in zip(res.hand_landmarks, res.hand_world_landmarks, res.handedness):
            # Preserve the prototype's mirrored-camera convention.
            label = {"Left": "Right", "Right": "Left"}[handedness[0].category_name]
            key = label + "2" if label in seen else label
            seen.add(key)
            hand = dict(key=key, label=label, lm=landmarks_to_array(lm), world=landmarks_to_array(world), t=now, held=False)
            self.last[key] = hand
            live.append(hand)

        hands = list(live)
        for key, hand in list(self.last.items()):
            if key in seen:
                continue
            palm = hand["lm"][PALM, :2].mean(axis=0)
            relabeled = any(np.linalg.norm(h["lm"][PALM, :2].mean(axis=0) - palm) < 0.15 for h in live)
            if now - hand["t"] > HOLD_TIME or relabeled:
                del self.last[key]
            else:
                hands.append({**hand, "held": True})
        return hands


def camera_matrix(w, h):
    f = (w / 2) / math.tan(math.radians(CAMERA_HFOV_DEG) / 2)
    return np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1]], dtype=np.float64)


def hand_in_camera(world, px, K):
    """Fit the metric, hand-centered model to pixels; return camera-space meters."""
    ok, rvec, tvec = cv2.solvePnP(world, px, K, None, flags=cv2.SOLVEPNP_SQPNP)
    if not ok or tvec[2, 0] <= 0:
        return None
    R, _ = cv2.Rodrigues(rvec)
    return world @ R.T + tvec.ravel()


class HandFrames:
    """Adapt real observations into the same camera-space protocol consumed by web/hands.js."""

    def __init__(self):
        self.tracker = HandTracker()
        self.states = {}
        self.size = None

    def update(self, result, observed_at, w, h):
        if self.size != (w, h):
            self.size = (w, h)
            self.K = camera_matrix(w, h)
            self.states.clear()
            self.tracker.last.clear()
        observations = self.tracker.update(result, observed_at)
        seen = {hand["key"] for hand in observations}
        self.states = {key: state for key, state in self.states.items() if key in seen}
        hands, sides = [], set()
        for hand in observations:
            key, side = hand["key"], hand["label"].lower()
            # The wire protocol addresses gestures by side. Never send two conflicting slots for one side.
            if side in sides:
                continue
            sides.add(side)
            if key not in self.states:
                self.states[key] = dict(filter=OneEuroFilter(min_cutoff=3.0, beta=4.0),
                                        gesture=GestureState(), packet=None)
            state = self.states[key]
            packet = state["packet"]
            if not hand["held"]:
                try:
                    cam = hand_in_camera(hand["world"], hand["lm"][:, :2] * [w, h], self.K)
                except cv2.error:
                    cam = None
                if cam is not None and np.isfinite(cam).all() and (cam[:, 2] > 0).all():
                    points = state["filter"](cam, hand["t"])
                    strength, pinching = state["gesture"].update(hand["world"])
                    packet = dict(side=side, lm=points.tolist(), pinch=strength,
                                  pinching=pinching, t=hand["t"])
                    state["packet"] = packet
            # Failed pose solves use the same short hold policy as failed detections.
            if packet is not None and observed_at - packet["t"] <= HOLD_TIME:
                hands.append({**packet, "held": packet["t"] != observed_at})
            elif packet is not None:
                del self.states[key]
        return dict(type="frame", t=observed_at, hands=hands, gaze=None, head=None)
