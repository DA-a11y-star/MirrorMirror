"""Webcam hand tracking with MediaPipe: 21 hand landmarks, finger-pinch gestures, fist detection,
hand depth and rotation, and 3D objects you can grab.

Modes:
    objects  (default) thumb + index pinch near a shape grabs it; move and turn your hand to move and rotate it.
             Pinch the same shape with your other hand too, then pull apart / push together to stretch / squeeze it
    mouse    palm moves the cursor, thumb + index = left click / drag, thumb + middle = right click
    juggle   both hands: close a hand (fist or pinch) on a ball to catch it, open while moving to throw

Thumb + ring and a closed fist are indicators only (a fist also cancels pinches).

Keys (in the preview window):
    m  toggle mouse mode
    j  toggle juggle mode
    c  toggle the camera image (tracking keeps running)
    r  reset the shapes, or the juggling balls and score
    p  print the current 21 landmarks to the terminal
    q / Esc  quit
"""

import math
import time

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision
from pynput.mouse import Button, Controller

from juggle import JuggleSim
from tracker.filters import OneEuroFilter
from tracker.gestures import CLOSE, OPEN, PINCH_TIPS, curled_count, pinch_distances, update_pinch
from tracker.hands import (
    CAPTURE_SIZE, MODEL_PATH, PALM, HandTracker, camera_matrix, ensure_model, hand_in_camera,
)

LANDMARK_NAMES = [
    "WRIST",
    "THUMB_CMC", "THUMB_MCP", "THUMB_IP", "THUMB_TIP",
    "INDEX_MCP", "INDEX_PIP", "INDEX_DIP", "INDEX_TIP",
    "MIDDLE_MCP", "MIDDLE_PIP", "MIDDLE_DIP", "MIDDLE_TIP",
    "RING_MCP", "RING_PIP", "RING_DIP", "RING_TIP",
    "PINKY_MCP", "PINKY_PIP", "PINKY_DIP", "PINKY_TIP",
]
CONNECTIONS = [(c.start, c.end) for c in vision.HandLandmarksConnections.HAND_CONNECTIONS]

# Fingers that can pinch against the thumb, and the mouse button each one drives (None = indicator only).
PINCH_BUTTONS = {"index": Button.left, "middle": Button.right, "ring": None}
MOUSE_LABELS = {"index": "L click", "middle": "R click", "ring": "ring"}
OBJECT_LABELS = {"index": "grab", "middle": "middle", "ring": "ring"}
GRAB_FINGER = "index"

# Region of the camera frame (normalized, after mirroring) that maps to the full screen.
# Smaller box = less arm movement needed to reach the screen edges.
ACTIVE_BOX = (0.20, 0.15, 0.80, 0.75)  # x0, y0, x1, y1

DEPTH_RANGE_M = (0.20, 0.90)

# Conjugating a hand rotation by this reverses its pitch and yaw but keeps roll, so held shapes turn the way
# the user sees their own hand turn rather than the way the camera sees it.
VIEWER_FLIP = np.diag([-1.0, -1.0, 1.0])
# Likewise for movement: pushing the hand toward the screen pushes a held shape deeper into the scene.
VIEWER_DEPTH = np.array([1.0, 1.0, -1.0])

# Limits on how far two-handed squeezing can stretch or flatten a shape along any axis.
MIN_STRETCH, MAX_STRETCH = 0.3, 4.0

FONT = cv2.FONT_HERSHEY_SIMPLEX


def rotation(axis, degrees):
    R, _ = cv2.Rodrigues(np.asarray(axis, dtype=np.float64) * math.radians(degrees))
    return R


class Shape:
    def __init__(self, verts, faces, color, home):
        self.verts = np.asarray(verts, dtype=np.float64)
        self.faces = faces
        self.color = color
        self.home = np.asarray(home, dtype=np.float64)
        self.radius = float(np.linalg.norm(self.verts, axis=1).max())
        self.reset()

    def reset(self):
        self.pos = self.home.copy()
        # Local -> camera linear map: a rotation, plus any stretch from two-handed squeezing.
        self.M = rotation((0, 1, 0), 35) @ rotation((1, 0, 0), -25)

    def camera_verts(self):
        return self.verts @ self.M.T + self.pos

    def reach(self):
        return self.radius * np.linalg.norm(self.M, 2)


def make_cube(size, color, home):
    s = size / 2
    verts = [(x, y, z) for x in (-s, s) for y in (-s, s) for z in (-s, s)]
    faces = [(0, 1, 3, 2), (4, 5, 7, 6), (0, 1, 5, 4), (2, 3, 7, 6), (0, 2, 6, 4), (1, 3, 7, 5)]
    return Shape(verts, faces, color, home)


def make_pyramid(size, color, home):
    s = size / 2
    verts = [(-s, s, -s), (s, s, -s), (s, s, s), (-s, s, s), (0, -s, 0)]  # camera y points down
    faces = [(0, 1, 2, 3), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
    return Shape(verts, faces, color, home)


def make_shapes():
    return [
        make_cube(0.07, (230, 160, 60), (-0.10, 0.0, 0.45)),
        make_pyramid(0.08, (180, 80, 220), (0.10, 0.0, 0.45)),
    ]


def screen_size():
    import tkinter as tk

    root = tk.Tk()
    root.withdraw()
    size = root.winfo_screenwidth(), root.winfo_screenheight()
    root.destroy()
    return size


def unit(v):
    return v / max(np.linalg.norm(v), 1e-9)


def map_to_screen(pt, screen_w, screen_h):
    x0, y0, x1, y1 = ACTIVE_BOX
    u = np.clip((pt[0] - x0) / (x1 - x0), 0.0, 1.0)
    v = np.clip((pt[1] - y0) / (y1 - y0), 0.0, 1.0)
    return np.array([u * (screen_w - 1), v * (screen_h - 1)])


def hand_axes(world):
    """Unit vectors in camera axes (x right, y down, z away from camera): up = wrist -> middle MCP, and the
    knuckle-plane normal, which only becomes the palm normal once the handedness sign is applied."""
    up = unit(world[9] - world[0])
    normal = np.cross(world[5] - world[0], world[17] - world[0])
    return up, unit(normal - np.dot(normal, up) * up)


def palm_sign(handedness):
    # In the mirrored frame, a right hand's knuckle-plane normal points out of the back of the hand.
    return -1.0 if handedness == "Right" else 1.0


def hand_angles(up, normal):
    """Degrees, from the user's point of view. roll: in-plane tilt (0 = fingers up).
    pitch: + = fingertips tilted back toward the user. yaw: 0 = palm facing camera, +/-180 = back of hand facing camera."""
    roll = math.degrees(math.atan2(up[0], -up[1]))
    pitch = math.degrees(math.asin(np.clip(up[2], -1.0, 1.0)))
    yaw = math.degrees(math.atan2(-normal[0], -normal[2]))
    return roll, pitch, yaw


def project(points, K):
    return (points[:, :2] / points[:, 2:3]) * [K[0, 0], K[1, 1]] + [K[0, 2], K[1, 2]]


def pick_shape(shapes, K, pt):
    """Index of the shape whose on-screen footprint contains pt (nearest center wins), or None."""
    best, best_d = None, float("inf")
    for i, s in enumerate(shapes):
        center = project(s.pos[None], K)[0]
        reach = 1.2 * K[0, 0] * s.reach() / s.pos[2]
        d = np.linalg.norm(center - pt)
        if d < reach and d < best_d:
            best, best_d = i, d
    return best


class HandState:
    """Gestures and smoothed pose for one tracked hand, kept across frames under its HandTracker key."""

    def __init__(self):
        self.active = None  # finger currently pinching the thumb
        self.was_active = None
        self.fist = False
        self.axes_filter = OneEuroFilter(min_cutoff=0.8, beta=0.4)
        self.pinch_filter = OneEuroFilter(min_cutoff=0.6, beta=1.0)
        self.depth_filter = OneEuroFilter(min_cutoff=1.0, beta=1.0)

    def update(self, hand, K, w, h):
        # Filters get the time the pose was seen, so a held pose doesn't count as new motion.
        t, world = hand["t"], hand["world"]
        self.hand = hand
        self.px_f = hand["lm"][:, :2] * [w, h]
        self.px = self.px_f.astype(int)

        self.dists = pinch_distances(world)
        curled = curled_count(world)
        self.fist = curled >= 3 if self.fist else curled == 4
        self.was_active = self.active
        self.active = update_pinch(self.active, self.dists, self.fist)

        up, knuckle_normal = hand_axes(world)
        smoothed = self.axes_filter(np.concatenate([up, knuckle_normal]), t)
        self.up = unit(smoothed[:3])
        knuckle_normal = unit(smoothed[3:] - np.dot(smoothed[3:], self.up) * self.up)
        # Built from the knuckle normal so a flicker in the handedness label can't spin a held shape.
        self.hand_R = np.column_stack([np.cross(self.up, knuckle_normal), self.up, knuckle_normal])
        self.normal = palm_sign(hand["label"]) * knuckle_normal
        self.side = np.cross(self.up, self.normal)

        cam = hand_in_camera(world, self.px_f, K)
        self.depth = self.pinch3d = None
        if cam is not None:
            self.depth = float(self.depth_filter(cam[:, 2].mean(), t))
            self.pinch3d = self.pinch_filter((cam[4] + cam[8]) / 2, t)
        self.pinch2d = (self.px_f[4] + self.px_f[PINCH_TIPS[GRAB_FINGER]]) / 2

    @property
    def grabbing(self):
        return self.active == GRAB_FINGER


def clamp_stretch(M):
    U, scales, Vt = np.linalg.svd(M)
    return U @ np.diag(np.clip(scales, MIN_STRETCH, MAX_STRETCH)) @ Vt


class ShapeHandler:
    """One hand pinching a shape moves and turns it. A second hand pinching the same shape switches to two-handed
    mode: the distance between the pinches stretches or squeezes the shape along the line joining them, and their
    midpoint moves it. When either hand lets go, the other carries on one-handed from the shape's current pose."""

    def __init__(self, shapes):
        self.shapes = shapes
        self.grabs = {}  # hand key -> pose of hand and shape when that hand grabbed
        self.squeeze = None

    def reset(self):
        self.grabs.clear()
        self.squeeze = None

    def grabbed(self):
        return {g["i"] for g in self.grabs.values()}

    def _grab(self, i, st):
        s = self.shapes[i]
        # Scale hand motion so the shape tracks the fingers on screen even at a different depth.
        return dict(i=i, hand_R=st.hand_R, M=s.M.copy(), pos=s.pos.copy(), pinch=st.pinch3d.copy(),
                    gain=s.pos[2] / st.pinch3d[2])

    def update(self, states, K):
        for key in [k for k in self.grabs if k not in states or not states[k].grabbing]:
            del self.grabs[key]
        if self.squeeze and not all(k in self.grabs for k in self.squeeze["keys"]):
            for k in self.squeeze["keys"]:
                if k in self.grabs and states[k].pinch3d is not None:
                    self.grabs[k] = self._grab(self.grabs[k]["i"], states[k])
            self.squeeze = None

        for key, st in states.items():
            if not st.grabbing or st.was_active == GRAB_FINGER or key in self.grabs or st.pinch3d is None:
                continue
            i = pick_shape(self.shapes, K, st.pinch2d)
            if i is None:
                continue
            holders = [k for k, g in self.grabs.items() if g["i"] == i]
            if not holders:
                self.grabs[key] = self._grab(i, st)
            elif len(holders) == 1 and self.squeeze is None and states[holders[0]].pinch3d is not None:
                self.grabs[key] = self._grab(i, st)
                p1, p2 = states[holders[0]].pinch3d, st.pinch3d
                s = self.shapes[i]
                self.squeeze = dict(i=i, keys=(holders[0], key), M=s.M.copy(), pos=s.pos.copy(),
                                    span=(p2 - p1) * VIEWER_DEPTH, mid=(p1 + p2) / 2,
                                    gain=s.pos[2] / ((p1[2] + p2[2]) / 2))

        if self.squeeze:
            sq = self.squeeze
            p1, p2 = (states[k].pinch3d for k in sq["keys"])
            if p1 is not None and p2 is not None:
                s = self.shapes[sq["i"]]
                # Floor the starting span so pinches that begin almost together can't produce a huge ratio.
                start = max(np.linalg.norm(sq["span"]), 0.02)
                ratio = np.linalg.norm((p2 - p1) * VIEWER_DEPTH) / start
                axis = unit(sq["span"])
                s.M = clamp_stretch((np.eye(3) + (ratio - 1) * np.outer(axis, axis)) @ sq["M"])
                s.pos = sq["pos"] + sq["gain"] * ((p1 + p2) / 2 - sq["mid"]) * VIEWER_DEPTH
                s.pos[2] = max(s.pos[2], 0.15)

        for key, g in self.grabs.items():
            st = states[key]
            if (self.squeeze and key in self.squeeze["keys"]) or st.pinch3d is None:
                continue
            s = self.shapes[g["i"]]
            turn = st.hand_R @ g["hand_R"].T
            s.M = VIEWER_FLIP @ turn @ VIEWER_FLIP @ g["M"]
            s.pos = g["pos"] + g["gain"] * (st.pinch3d - g["pinch"]) * VIEWER_DEPTH
            s.pos[2] = max(s.pos[2], 0.15)

    def draw(self, frame, states):
        if not self.squeeze:
            return
        a, b = (states[k].pinch2d.astype(int) for k in self.squeeze["keys"])
        cv2.line(frame, tuple(a), tuple(b), (255, 255, 255), 2, cv2.LINE_AA)
        scales = np.linalg.svd(self.shapes[self.squeeze["i"]].M, compute_uv=False)
        mid = (a + b) // 2
        cv2.putText(frame, f"x{scales.max():.2f} / x{scales.min():.2f}", (mid[0] - 50, mid[1] - 12), FONT, 0.55,
                    (255, 255, 255), 2)


def draw_shapes(frame, shapes, K, hovered, grabbed):
    faces = []
    for i, s in enumerate(shapes):
        V = s.camera_verts()
        if (V[:, 2] < 0.05).any():
            continue
        uv = project(V, K)
        for face in s.faces:
            P = V[list(face)]
            c = P.mean(axis=0)
            n = unit(np.cross(P[1] - P[0], P[2] - P[0]))
            if np.dot(n, c - s.pos) < 0:
                n = -n
            if np.dot(n, c) >= 0:
                continue  # facing away from the camera
            shade = 0.35 + 0.65 * -np.dot(n, unit(c))
            faces.append((c[2], i, uv[list(face)], shade))
    for _, i, poly, shade in sorted(faces, key=lambda f: -f[0]):
        pts = poly.round().astype(np.int32)
        cv2.fillConvexPoly(frame, pts, tuple(int(ch * shade) for ch in shapes[i].color), cv2.LINE_AA)
        if i in grabbed:
            edge, thickness = (255, 255, 255), 2
        elif i in hovered:
            edge, thickness = (0, 255, 255), 2
        else:
            edge, thickness = (30, 30, 30), 1
        cv2.polylines(frame, [pts], True, edge, thickness, cv2.LINE_AA)


def draw_hand(frame, px, held=False):
    for a, b in CONNECTIONS:
        cv2.line(frame, tuple(px[a]), tuple(px[b]), (130, 130, 130) if held else (0, 255, 0), 2)
    for i, (x, y) in enumerate(px):
        cv2.circle(frame, (x, y), 4, (0, 0, 255), -1)
        cv2.putText(frame, str(i), (x + 5, y - 5), FONT, 0.35, (255, 255, 255), 1)


def draw_gestures(frame, px, dists, active, fist, labels):
    x, y = 10, 50
    for finger in PINCH_TIPS:
        on = finger == active
        closeness = np.clip((OPEN - dists[finger]) / OPEN, 0.0, 1.0) if dists else 0.0
        color = (0, 0, 255) if on else (200, 200, 200)
        cv2.rectangle(frame, (x, y), (x + 120, y + 18), (60, 60, 60), -1)
        cv2.rectangle(frame, (x, y), (x + int(120 * closeness), y + 18), color, -1)
        cv2.line(frame, (x + int(120 * (OPEN - CLOSE) / OPEN), y), (x + int(120 * (OPEN - CLOSE) / OPEN), y + 18), (255, 255, 255), 1)
        cv2.putText(frame, labels[finger], (x + 128, y + 14), FONT, 0.5, color, 1 if not on else 2)
        if on and px is not None:
            mid = (px[4] + px[PINCH_TIPS[finger]]) // 2
            cv2.circle(frame, tuple(mid), 9, color, -1)
        y += 24
    color = (0, 140, 255) if fist else (200, 200, 200)
    cv2.rectangle(frame, (x, y), (x + 120, y + 18), color if fist else (60, 60, 60), -1)
    cv2.putText(frame, "FIST", (x + 128, y + 14), FONT, 0.5, color, 2 if fist else 1)


def draw_depth(frame, depth):
    h, w = frame.shape[:2]
    x0, x1, top, bottom = w - 40, w - 20, 60, h - 60
    cv2.rectangle(frame, (x0, top), (x1, bottom), (60, 60, 60), -1)
    cv2.putText(frame, "near", (x0 - 12, top - 8), FONT, 0.45, (255, 255, 255), 1)
    cv2.putText(frame, "far", (x0 - 6, bottom + 20), FONT, 0.45, (255, 255, 255), 1)
    if depth is None:
        return
    near, far = DEPTH_RANGE_M
    frac = np.clip((depth - near) / (far - near), 0.0, 1.0)
    y = int(top + frac * (bottom - top))
    cv2.rectangle(frame, (x0, top), (x1, y), (255, 200, 0), -1)
    cv2.line(frame, (x0 - 6, y), (x1 + 6, y), (255, 255, 255), 2)
    text = f"{depth * 100:.0f} cm"
    (tw, _), _ = cv2.getTextSize(text, FONT, 0.55, 2)
    cv2.putText(frame, text, (x0 - tw - 10, y + 6), FONT, 0.55, (255, 200, 0), 2)


def draw_rotation(frame, px, up, normal, side, angles):
    origin = px[PALM].mean(axis=0).astype(int)
    for vec, color, name in ((side, (0, 0, 255), "x"), (up, (0, 255, 0), "y"), (normal, (255, 0, 0), "n")):
        end = (origin + 70 * vec[:2]).astype(int)
        cv2.arrowedLine(frame, tuple(origin), tuple(end), color, 3, tipLength=0.2)
        cv2.putText(frame, name, tuple(end + 4), FONT, 0.5, color, 2)
    roll, pitch, yaw = angles
    facing = "palm" if abs(yaw) < 90 else "back"
    h = frame.shape[0]
    cv2.putText(frame, f"roll {roll:+4.0f}  pitch {pitch:+4.0f}  yaw {yaw:+4.0f}  ({facing} to camera)",
                (10, h - 15), FONT, 0.6, (255, 255, 255), 2)


def main():
    ensure_model()
    screen_w, screen_h = screen_size()
    mouse = Controller()

    options = vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.6,
        min_hand_presence_confidence=0.6,
        min_tracking_confidence=0.6,
    )
    landmarker = vision.HandLandmarker.create_from_options(options)

    print("Opening webcam...")
    cap = cv2.VideoCapture(0)
    # On first run macOS shows a permission prompt asynchronously, so keep retrying while the user answers it.
    deadline = time.monotonic() + 30
    while not cap.isOpened() and time.monotonic() < deadline:
        time.sleep(1)
        cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        raise SystemExit(
            "Could not open webcam. Allow camera access for the app you're running this from in "
            "System Settings > Privacy & Security > Camera, then fully quit and reopen that app."
        )
    # The default 1080p capture spends most of each frame flipping, converting and drawing pixels.
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAPTURE_SIZE[0])
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAPTURE_SIZE[1])
    cap.set(cv2.CAP_PROP_FPS, 30)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    print("Webcam open. Press q in the 'Hand Mouse' window to quit.")

    cursor_filter = OneEuroFilter()
    tracker = HandTracker()
    states = {}  # hand key -> HandState
    primary_key = None  # hand that drives the cursor and the single-hand indicators; sticks while it stays tracked
    shapes = make_shapes()
    handler = ShapeHandler(shapes)
    held = None  # mouse button currently held down
    mode = "objects"  # "objects", "mouse" or "juggle"
    juggler = None
    show_camera = True
    t0 = time.monotonic()
    last_ts_ms = -1
    fps, t_prev = 0.0, time.monotonic()

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frame = cv2.flip(frame, 1)
            h, w = frame.shape[:2]
            K = camera_matrix(w, h)

            now = time.monotonic()
            ts_ms = max(int((now - t0) * 1000), last_ts_ms + 1)  # must be strictly increasing
            last_ts_ms = ts_ms
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            res = landmarker.detect_for_video(image, ts_ms)
            mouse_mode = mode == "mouse"
            hands = tracker.update(res, now)

            states = {hand["key"]: states.get(hand["key"]) or HandState() for hand in hands}
            for hand in hands:
                states[hand["key"]].update(hand, K, w, h)
            if primary_key not in states:
                primary_key = hands[0]["key"] if hands else None
                cursor_filter.reset()
            primary = states.get(primary_key)
            active = primary.active if primary else None

            hovered = set()
            if primary and mouse_mode:
                # Palm center stays put while fingertips pinch, so clicking doesn't drag the cursor.
                target = map_to_screen(primary.hand["lm"][PALM, :2].mean(axis=0), screen_w, screen_h)
                mouse.position = tuple(cursor_filter(target, primary.hand["t"]))
            elif mode == "objects":
                handler.update(states, K)
                for key, st in states.items():
                    if key not in handler.grabs:
                        i = pick_shape(shapes, K, st.pinch2d)
                        if i is not None:
                            hovered.add(i)

            want = PINCH_BUTTONS[active] if mouse_mode and active else None
            if want != held:
                if held is not None:
                    mouse.release(held)
                if want is not None:
                    mouse.press(want)
                held = want

            all_px = []
            if mode == "juggle":
                if juggler is None:
                    juggler = JuggleSim(w, h)
                observations = {}
                for hand in hands:
                    hand_px = hand["lm"][:, :2] * [w, h]
                    palm_radius = 0.6 * np.linalg.norm(hand_px[9] - hand_px[0])
                    observations[hand["key"]] = (hand_px[PALM].mean(axis=0), palm_radius, curled_count(hand["world"]),
                                                 pinch_distances(hand["world"])[GRAB_FINGER], hand["t"])
                    all_px.append((hand_px.astype(int), hand["held"]))
                juggler.update(observations, now, CLOSE, OPEN)

            dt = now - t_prev
            t_prev = now
            fps = 0.9 * fps + 0.1 * (1.0 / dt if dt > 0 else 0.0)

            if not show_camera:
                frame[:] = 30
            if mouse_mode:
                x0, y0, x1, y1 = ACTIVE_BOX
                cv2.rectangle(frame, (int(x0 * w), int(y0 * h)), (int(x1 * w), int(y1 * h)), (255, 200, 0), 1)
            if mode == "juggle":
                for hand_px, held_pose in all_px:
                    draw_hand(frame, hand_px, held_pose)
                juggler.draw(frame)
                hand_text = f"{len(all_px)} hand{'s' if len(all_px) != 1 else ''}"
            else:
                draw_shapes(frame, shapes, K, hovered, handler.grabbed())
                for st in states.values():
                    draw_hand(frame, st.px, st.hand["held"])
                    draw_rotation(frame, st.px, st.up, st.normal, st.side, hand_angles(st.up, st.normal))
                if mode == "objects":
                    handler.draw(frame, states)
                labels = MOUSE_LABELS if mouse_mode else OBJECT_LABELS
                if primary:
                    draw_gestures(frame, primary.px, primary.dists, primary.active, primary.fist, labels)
                else:
                    draw_gestures(frame, None, {}, None, False, labels)
                draw_depth(frame, primary.depth if primary else None)
                hand_text = " + ".join(f"{st.hand['label']} hand" for st in states.values()) or "no hand"
            status = f"{mode.upper()} mode (m/j)  |  {hand_text}  |  {fps:4.1f} fps"
            cv2.putText(frame, status, (10, 25), FONT, 0.6, (0, 255, 255), 2)
            cv2.imshow("Hand Mouse", frame)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key in (ord("m"), ord("j")):
                target_mode = "mouse" if key == ord("m") else "juggle"
                mode = "objects" if mode == target_mode else target_mode
                handler.reset()
                cursor_filter.reset()
            if key == ord("c"):
                show_camera = not show_camera
            if key == ord("r"):
                if mode == "juggle" and juggler is not None:
                    juggler.reset()
                else:
                    handler.reset()
                    for s in shapes:
                        s.reset()
            if key == ord("p") and primary:
                lm, world = primary.hand["lm"], primary.hand["world"]
                for i, (name, (x, y, z), (wx, wy, wz)) in enumerate(zip(LANDMARK_NAMES, lm, world)):
                    print(f"{i:2d} {name:<11} x={x:.3f} y={y:.3f} z={z:+.3f}   "
                          f"world=({wx * 100:+5.1f}, {wy * 100:+5.1f}, {wz * 100:+5.1f}) cm")
                print()
    finally:
        if held is not None:
            mouse.release(held)
        cap.release()
        landmarker.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
