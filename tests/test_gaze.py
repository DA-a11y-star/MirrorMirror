import time
import unittest
from types import SimpleNamespace

import numpy as np

from tracker.capture import LatestValue
from tracker.gaze import GazeWorker, eye_features


def face_points(closed=False):
    points = np.full((478, 2), [320., 240.])
    for a, b, top, bottom, iris, x in [(33, 133, 159, 145, 468, 270), (362, 263, 386, 374, 473, 370)]:
        points[a] = [x - 20, 220]
        points[b] = [x + 20, 220]
        points[top] = [x, 220 if closed else 214]
        points[bottom] = [x, 220 if closed else 226]
        points[iris] = [x + 3, 221]
    points[1] = [325, 260]
    return points


def landmarks(points):
    return [SimpleNamespace(x=x / 640, y=y / 480) for x, y in points]


class GazeTests(unittest.TestCase):
    def test_features_measure_iris_displacement_and_head_offset(self):
        features = eye_features(landmarks(face_points()), 640, 480)
        np.testing.assert_allclose(features, [.075, .025, .05, .4])

    def test_eye_features_are_translation_and_scale_invariant(self):
        points = face_points()
        expected = eye_features(landmarks(points), 640, 480)
        actual = eye_features(landmarks(points * 1.5 + [15, -20]), 640, 480)
        np.testing.assert_allclose(actual, expected)

    def test_eye_displacement_is_invariant_to_roll(self):
        points = face_points()
        angle = .3
        rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
        rotated = (points - [320, 240]) @ rotation.T + [320, 240]
        np.testing.assert_allclose(eye_features(landmarks(rotated), 640, 480)[:2], [.075, .025])

    def test_blinks_tiny_faces_missing_irises_and_nan_are_rejected(self):
        self.assertIsNone(eye_features(landmarks(face_points(closed=True)), 640, 480))
        self.assertIsNone(eye_features(landmarks(face_points() * .1), 640, 480))
        self.assertIsNone(eye_features(landmarks(face_points())[:468], 640, 480))
        points = face_points()
        points[468, 0] = np.nan
        self.assertIsNone(eye_features(landmarks(points), 640, 480))

    def test_stale_gaze_cannot_be_merged_as_current(self):
        worker = GazeWorker(SimpleNamespace(frames=LatestValue()))
        self.assertEqual(worker.latest()["conf"], 0)
        worker.frames.put(dict(t=time.monotonic() - 1, conf=.8, source="webcam", features=[0, 0, 0, 0]))
        self.assertEqual(worker.latest()["conf"], 0)
        current = dict(t=time.monotonic(), conf=.8, source="webcam", features=[0, 0, 0, 0])
        worker.frames.put(current)
        self.assertEqual(worker.latest(), current)
        worker.error = RuntimeError("test provider disconnected")
        self.assertEqual(worker.latest()["conf"], 0)
        self.assertIn("disconnected", worker.latest()["status"])


if __name__ == "__main__":
    unittest.main()
