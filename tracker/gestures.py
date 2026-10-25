"""The prototype's hand-size-normalized gestures, plus one-frame pose labels for the browser.

Python classifies a static pose per frame. Temporal machines (mode toggle, joystick) live in
web/gestures.js so feel can be tuned with a browser reload.
"""

import numpy as np

PINCH_TIPS = {"index": 8, "middle": 12, "ring": 16}
CURL_JOINTS = [(8, 6), (12, 10), (16, 14), (20, 18)]
# Four fingers: (tip, pip, mcp). Open = tip farther from the wrist than PIP; fist = tip closer than MCP.
FINGERS = [(8, 6, 5), (12, 10, 9), (16, 14, 13), (20, 18, 17)]
PALM_IDS = [0, 5, 9, 13, 17]
PINCH_SCALE = 0.3  # thumb-index image distance below this × palm.scale is a pinch
CLOSE, OPEN = 0.40, 0.46


def pinch_distances(world):
    scale = max(np.linalg.norm(world[9] - world[0]), 1e-9)
    return {f: np.linalg.norm(world[4] - world[tip]) / scale for f, tip in PINCH_TIPS.items()}


def curled_count(world):
    return sum(np.linalg.norm(world[tip] - world[0]) < np.linalg.norm(world[pip] - world[0]) for tip, pip in CURL_JOINTS)


def update_pinch(active, dists, fist):
    """Closest finger starts below CLOSE; keep it active until it exceeds OPEN."""
    if fist:
        return None
    if active is not None:
        return None if dists[active] > OPEN else active
    finger = min(dists, key=dists.get)
    return finger if dists[finger] < CLOSE else None


def classify_pose(world, image):
    """One-frame pose + palm features. `world` is 21×3 metric landmarks; `image` is 21×2/3 normalized pixels.

    After the tracker mirrors the webcam, image x already grows toward the user's right, so palm.x is not
    flipped again. `palm.scale` is the 2D wrist-to-middle-MCP length and grows as the hand approaches the camera.
    Ambiguous shapes report `other` rather than guessing.
    """
    world = np.asarray(world, dtype=float)
    xy = np.asarray(image, dtype=float)[:, :2]
    palm_xy = xy[PALM_IDS].mean(axis=0)
    scale = float(max(np.linalg.norm(xy[9] - xy[0]), 1e-6))
    palm = dict(x=float(palm_xy[0]), y=float(palm_xy[1]), scale=scale)

    wrist = world[0]
    dist = lambda i: float(np.linalg.norm(world[i] - wrist))
    # Real fists rarely satisfy a strict 4-finger MCP test. 3 curled (tip closer than PIP) is a fist;
    # 3 extended is open. A closed fist still wins over a thumb-index pinch so the mode toggle can fire.
    curled_n = sum(dist(tip) < dist(pip) for tip, pip, _mcp in FINGERS)
    open_n = sum(dist(tip) > dist(pip) for tip, pip, _mcp in FINGERS)
    pinch_d = float(np.linalg.norm(xy[4] - xy[8]))
    is_pinch = pinch_d < PINCH_SCALE * scale

    if curled_n >= 3:
        margins = [(dist(pip) - dist(tip)) / (dist(pip) + 1e-9) for tip, pip, _mcp in FINGERS]
        return "fist", float(np.clip(sorted(margins)[-3] * 2, 0, 1)), palm
    if is_pinch:
        return "pinch", float(np.clip(1 - pinch_d / (PINCH_SCALE * scale), 0, 1)), palm
    if open_n >= 3:
        margins = [(dist(tip) - dist(pip)) / (dist(tip) + 1e-9) for tip, pip, _mcp in FINGERS]
        return "open", float(np.clip(sorted(margins)[-3] * 3, 0, 1)), palm
    return "other", 0.3, palm


class GestureState:
    def __init__(self):
        self.active = None
        self.fist = False

    def update(self, world):
        dists = pinch_distances(world)
        curled = curled_count(world)
        self.fist = bool(curled >= 3 if self.fist else curled == 4)
        self.active = update_pinch(self.active, dists, self.fist)
        strength = float(np.clip(1 - dists["index"] / OPEN, 0, 1))
        return strength, self.active == "index"


class PinchEvents:
    """Per-subscriber transitions: reconnecting mid-pinch reconstructs active state."""

    def __init__(self):
        self.active = set()

    def update(self, hands):
        active = {h["side"] for h in hands if h["pinching"]}
        events = [dict(type="gesture", name="pinch_end", hand=side) for side in sorted(self.active - active)]
        events += [dict(type="gesture", name="pinch_start", hand=side) for side in sorted(active - self.active)]
        self.active = active
        return events
