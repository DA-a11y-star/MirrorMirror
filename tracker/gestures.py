"""The prototype's hand-size-normalized gestures and wire-format transitions."""

import numpy as np

PINCH_TIPS = {"index": 8, "middle": 12, "ring": 16}
CURL_JOINTS = [(8, 6), (12, 10), (16, 14), (20, 18)]
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
