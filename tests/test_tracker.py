import asyncio
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from tracker.capture import LatestValue
from tracker.filters import OneEuroFilter
from tracker.gestures import GestureState, PinchEvents
from tracker.hands import HOLD_TIME, HandFrames, camera_matrix
from tracker.main import TrackerServer


# Same open-hand geometry as the browser mock, with non-planar landmarks for a real solvePnP round trip.
OPEN_HAND = np.array([
    [0, 0, 0], [.010, -.016, -.017], [.019, -.038, -.017], [.015, -.054, -.026],
    [.011, -.077, -.027], [.006, -.069, -.005], [.007, -.084, -.015], [.016, -.103, -.019],
    [.017, -.133, -.030], [0, -.070, 0], [.003, -.090, -.009], [.002, -.125, -.011],
    [.009, -.154, -.017], [-.010, -.071, -.003], [-.006, -.089, -.007], [-.023, -.119, -.008],
    [0, -.150, -.009], [-.017, -.061, -.004], [-.021, -.076, -.006], [-.023, -.104, -.004],
    [-.022, -.126, -.009],
])


def observation(ratio=0.2, label="Left", x=0.05):
    world = OPEN_HAND.copy()
    world[4] = world[8] + [ratio * np.linalg.norm(world[9] - world[0]), 0, 0]
    translation = np.array([x, .1, .5])
    px, _ = cv2.projectPoints(world, np.zeros(3), translation, camera_matrix(640, 480), None)
    image = np.column_stack([px.reshape(-1, 2) / [640, 480], np.zeros(21)])
    landmarks = lambda points: [SimpleNamespace(x=p[0], y=p[1], z=p[2]) for p in points]
    return SimpleNamespace(hand_landmarks=[landmarks(image)], hand_world_landmarks=[landmarks(world)],
                           handedness=[[SimpleNamespace(category_name=label)]]), world + translation


def empty_observation():
    return SimpleNamespace(hand_landmarks=[], hand_world_landmarks=[], handedness=[])


class HandFrameTests(unittest.TestCase):
    def test_camera_space_round_trip_and_protocol(self):
        adapter = HandFrames()
        result, expected = observation()
        frame = adapter.update(result, 1.0, 640, 480)
        hand = frame["hands"][0]
        self.assertEqual(hand["side"], "right")
        self.assertEqual(len(hand["lm"]), 21)
        np.testing.assert_allclose(hand["lm"], expected, atol=1e-5)
        self.assertTrue(hand["pinching"])
        self.assertFalse(hand["held"])
        self.assertIsNone(frame["head"])
        self.assertIsNone(frame["gaze"])
        json.dumps(frame, allow_nan=False)

    def test_dropout_holds_original_pose_then_ends_pinch(self):
        adapter, events = HandFrames(), PinchEvents()
        result, _ = observation()
        first = adapter.update(result, 1.0, 640, 480)
        self.assertEqual(events.update(first["hands"])[0]["name"], "pinch_start")
        held = adapter.update(empty_observation(), 1.2, 640, 480)
        self.assertEqual(held["hands"][0]["t"], 1.0)
        self.assertEqual(held["hands"][0]["lm"], first["hands"][0]["lm"])
        self.assertTrue(held["hands"][0]["held"])
        self.assertEqual(events.update(held["hands"]), [])
        expired = adapter.update(empty_observation(), 1 + HOLD_TIME + .01, 640, 480)
        self.assertEqual(expired["hands"], [])
        self.assertEqual(events.update(expired["hands"]), [dict(type="gesture", name="pinch_end", hand="right")])
        self.assertEqual(events.update([]), [])

    def test_failed_pose_solve_expires_and_recovery_resets_smoothing(self):
        adapter = HandFrames()
        result, _ = observation()
        adapter.update(result, 1.0, 640, 480)
        with patch("tracker.hands.hand_in_camera", return_value=None):
            self.assertTrue(adapter.update(result, 1.1, 640, 480)["hands"][0]["held"])
            self.assertEqual(adapter.update(result, 1.5, 640, 480)["hands"], [])
        moved, expected = observation(x=-.1)
        recovered = adapter.update(moved, 1.6, 640, 480)
        np.testing.assert_allclose(recovered["hands"][0]["lm"], expected, atol=1e-5)

    def test_nan_pose_is_not_published(self):
        with patch("tracker.hands.hand_in_camera", return_value=np.full((21, 3), np.nan)):
            self.assertEqual(HandFrames().update(observation()[0], 1.0, 640, 480)["hands"], [])

    def test_two_hands_and_duplicate_side_never_conflict(self):
        right, _ = observation(label="Left", x=.12)
        left, _ = observation(label="Right", x=-.12)
        for field in ("hand_landmarks", "hand_world_landmarks", "handedness"):
            getattr(right, field).extend(getattr(left, field))
        hands = HandFrames().update(right, 1.0, 640, 480)["hands"]
        self.assertEqual({h["side"] for h in hands}, {"left", "right"})
        right.handedness[1][0].category_name = "Left"
        hands = HandFrames().update(right, 1.0, 640, 480)["hands"]
        self.assertEqual(len(hands), 1)

    def test_index_pinch_hysteresis(self):
        state = GestureState()
        for ratio, expected in [(.6, False), (.39, True), (.43, True), (.47, False), (.43, False)]:
            result, _ = observation(ratio=ratio)
            world = np.array([[p.x, p.y, p.z] for p in result.hand_world_landmarks[0]])
            strength, pinching = state.update(world)
            self.assertEqual(pinching, expected)
            self.assertTrue(0 <= strength <= 1)

    def test_filter_does_not_advance_replayed_observations(self):
        smooth = OneEuroFilter()
        initial = smooth(np.ones((21, 3)), 1.0)
        np.testing.assert_array_equal(smooth(np.zeros((21, 3)), 1.0), initial)
        np.testing.assert_array_equal(smooth(np.zeros((21, 3)), .9), initial)

    def test_capture_slot_discards_backlog(self):
        slot = LatestValue()
        for value in range(100):
            slot.put(value)
        self.assertEqual(slot.get(), (100, 99))


class WebSocketTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.frames = LatestValue()
        self.server = await serve(TrackerServer(self.frames).handle, "127.0.0.1", 0, compression=None)
        self.url = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    def publish(self, pinching=True):
        frame = HandFrames().update(observation(ratio=.2 if pinching else .8)[0], time.monotonic(), 640, 480)
        self.frames.put(frame)
        return frame

    async def receive(self, client):
        return json.loads(await asyncio.wait_for(client.recv(), 1))

    async def test_frames_transitions_and_reconnect_mid_pinch(self):
        self.publish()
        async with connect(self.url, proxy=None) as first:
            self.assertEqual((await self.receive(first))["type"], "frame")
            self.assertEqual((await self.receive(first))["name"], "pinch_start")
            self.publish()
            self.assertEqual((await self.receive(first))["type"], "frame")
            async with connect(self.url, proxy=None) as second:
                self.assertEqual((await self.receive(second))["type"], "frame")
                self.assertEqual((await self.receive(second))["name"], "pinch_start")
                self.publish(False)
                for client in (first, second):
                    self.assertFalse((await self.receive(client))["hands"][0]["pinching"])
                    self.assertEqual((await self.receive(client))["name"], "pinch_end")

    async def test_missing_hand_releases_once(self):
        self.publish()
        async with connect(self.url, proxy=None) as client:
            await self.receive(client)
            await self.receive(client)
            self.frames.put(dict(type="frame", t=time.monotonic(), hands=[], gaze=None, head=None))
            self.assertEqual((await self.receive(client))["hands"], [])
            self.assertEqual((await self.receive(client))["name"], "pinch_end")
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(client.recv(), .05)

    async def test_late_join_does_not_receive_a_stale_pose(self):
        frame = self.publish()
        self.frames.put({**frame, "t": time.monotonic() - 2})
        async with connect(self.url, proxy=None) as client:
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(client.recv(), .05)
            self.publish(False)
            self.assertFalse((await self.receive(client))["hands"][0]["pinching"])


if __name__ == "__main__":
    unittest.main()
