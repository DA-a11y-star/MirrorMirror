"""2D juggling sim in screen pixels, driven by up to two tracked hands.

Closing a hand (fist or thumb-index pinch) near a ball catches it; opening the hand throws it with the hand's
recent velocity. Balls pass through open hands.
"""

from collections import deque

import cv2
import numpy as np

GRAVITY = 450.0  # px/s^2; lower it to slow the whole game down
DRAG = 0.8  # 1/s air drag; falling balls level off at GRAVITY / DRAG px/s
BALL_RADIUS = 18
BALL_COLORS = [(60, 80, 240), (60, 200, 250), (230, 120, 60)]  # BGR: red, yellow, blue
CATCH_MARGIN = 25  # px beyond palm + ball radius that still counts as a catch
THROW_GAIN = 0.7
MAX_SPEED = 1400.0
WALL_BOUNCE = 0.8
CEILING_BOUNCE = 0.2
RECATCH_DELAY = 0.25  # s a thrown ball ignores catches, so opening the hand doesn't instantly re-grab it
VELOCITY_WINDOW = 0.12  # s of palm history used to estimate throw velocity
SUBSTEPS = 4


class Ball:
    def __init__(self, color):
        self.color = color
        self.pos = np.zeros(2)
        self.vel = np.zeros(2)
        self.held_by = None
        self.no_catch_until = 0.0


class Hand:
    def __init__(self):
        self.history = deque()
        self.palm = np.zeros(2)
        self.radius = 30.0
        self.vel = np.zeros(2)
        self.closed = False
        self.ball = None

    def update(self, palm, radius, curled, pinch, close, open_, seen_at):
        """seen_at is when this pose was observed; a held pose repeats an older time and is ignored, so after a
        tracking gap the velocity spans the real elapsed time instead of one frame."""
        if self.history and seen_at <= self.history[-1][0]:
            return
        self.palm, self.radius = palm, radius
        self.history.append((seen_at, palm))
        while len(self.history) > 2 and seen_at - self.history[0][0] > VELOCITY_WINDOW:
            self.history.popleft()
        (t0, p0), (t1, p1) = self.history[0], self.history[-1]
        self.vel = (p1 - p0) / (t1 - t0) if t1 > t0 else np.zeros(2)
        if self.closed:
            self.closed = curled >= 2 or pinch < open_
        else:
            self.closed = curled >= 3 or pinch < close


class JuggleSim:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.rng = np.random.default_rng()
        self.balls = [Ball(c) for c in BALL_COLORS]
        self.hands = {}
        self.t_prev = None
        self.reset()

    def reset(self):
        for i, b in enumerate(self.balls):
            self._respawn(b, delay_px=i * 220)
        for hand in self.hands.values():
            hand.ball = None
        self.catches = self.streak = self.best = self.drops = 0

    def _respawn(self, ball, delay_px=0):
        ball.pos = np.array([self.rng.uniform(0.3, 0.7) * self.w, -BALL_RADIUS - delay_px])
        ball.vel = np.zeros(2)
        ball.held_by = None

    def update(self, observations, now, close, open_):
        """observations: {hand_key: (palm_px, palm_radius_px, curled_finger_count, index_pinch_ratio, seen_at)}."""
        dt = 0.0 if self.t_prev is None else min(now - self.t_prev, 0.05)
        self.t_prev = now

        for key in list(self.hands):
            if key not in observations:
                self._release(self.hands.pop(key), now)
        for key, (palm, radius, curled, pinch, seen_at) in observations.items():
            hand = self.hands.setdefault(key, Hand())
            was_closed = hand.closed
            hand.update(np.asarray(palm, dtype=float), radius, curled, pinch, close, open_, seen_at)
            if was_closed and not hand.closed:
                self._release(hand, now)

        for hand in self.hands.values():
            if hand.ball is not None:
                hand.ball.pos = hand.palm.copy()
                hand.ball.vel = hand.vel.copy()
            elif hand.closed:
                self._try_catch(hand, now)

        step = dt / SUBSTEPS
        for _ in range(SUBSTEPS):
            for ball in self.balls:
                if ball.held_by is None:
                    self._step(ball, step)

    def _try_catch(self, hand, now):
        reach = hand.radius + BALL_RADIUS + CATCH_MARGIN
        free = [b for b in self.balls if b.held_by is None and now >= b.no_catch_until]
        if not free:
            return
        ball = min(free, key=lambda b: np.linalg.norm(b.pos - hand.palm))
        if np.linalg.norm(ball.pos - hand.palm) < reach:
            ball.held_by, hand.ball = hand, ball
            self.catches += 1
            self.streak += 1
            self.best = max(self.best, self.streak)

    def _release(self, hand, now):
        ball = hand.ball
        if ball is None:
            return
        v = hand.vel * THROW_GAIN
        speed = np.linalg.norm(v)
        ball.vel = v * (MAX_SPEED / speed) if speed > MAX_SPEED else v
        ball.held_by, hand.ball = None, None
        ball.no_catch_until = now + RECATCH_DELAY

    def _step(self, ball, dt):
        ball.vel[1] += GRAVITY * dt
        ball.vel *= np.exp(-DRAG * dt)
        ball.pos += ball.vel * dt

        if ball.pos[1] < BALL_RADIUS and ball.vel[1] < 0:
            ball.pos[1], ball.vel[1] = BALL_RADIUS, -ball.vel[1] * CEILING_BOUNCE
        if ball.pos[0] < BALL_RADIUS:
            ball.pos[0], ball.vel[0] = BALL_RADIUS, abs(ball.vel[0]) * WALL_BOUNCE
        elif ball.pos[0] > self.w - BALL_RADIUS:
            ball.pos[0], ball.vel[0] = self.w - BALL_RADIUS, -abs(ball.vel[0]) * WALL_BOUNCE

        if ball.pos[1] - BALL_RADIUS > self.h:
            self.drops += 1
            self.streak = 0
            self._respawn(ball)

    def draw(self, frame):
        for hand in self.hands.values():
            center = tuple(hand.palm.astype(int))
            if hand.closed:
                cv2.circle(frame, center, int(hand.radius), (0, 140, 255), 3, cv2.LINE_AA)
            else:
                cv2.circle(frame, center, int(hand.radius), (0, 255, 0), 1, cv2.LINE_AA)

        for ball in self.balls:
            x, y = ball.pos.astype(int)
            if y < -BALL_RADIUS:
                cv2.drawMarker(frame, (int(np.clip(x, 10, self.w - 10)), 12), ball.color, cv2.MARKER_TRIANGLE_UP, 16, 3)
                continue
            cv2.circle(frame, (x, y), BALL_RADIUS, ball.color, -1, cv2.LINE_AA)
            cv2.circle(frame, (x - 6, y - 6), 5, (255, 255, 255), -1, cv2.LINE_AA)
            edge = (255, 255, 255) if ball.held_by else (20, 20, 20)
            cv2.circle(frame, (x, y), BALL_RADIUS, edge, 2, cv2.LINE_AA)

        text = f"catches {self.catches}   streak {self.streak}   best {self.best}   drops {self.drops}"
        cv2.putText(frame, text, (10, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
