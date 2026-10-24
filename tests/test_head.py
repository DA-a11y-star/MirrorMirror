import math
import unittest

import numpy as np

from test_gaze import face_points, landmarks
from tracker.gaze import EYE_SPAN_M, head_position, head_rotation
from tracker.hands import CAMERA_HFOV_DEG

W, H = 640, 480
FOCAL = (W / 2) / math.tan(math.radians(CAMERA_HFOV_DEG) / 2)


def rotation_y(degrees):
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def transform(r):
    m = np.eye(4)
    m[:3, :3] = r
    return m


class HeadPositionTests(unittest.TestCase):
    def test_distance_follows_the_pixel_gap_between_the_eyes(self):
        # face_points puts the eye centers 100 px apart, centered at x=320, y=220.
        x, y, z = head_position(landmarks(face_points()), W, H)
        self.assertAlmostEqual(z, FOCAL * EYE_SPAN_M / 100, places=6)
        self.assertAlmostEqual(x, 0.0, places=6)
        self.assertAlmostEqual(y, (220 - H / 2) / FOCAL * z, places=6)

    def test_halving_the_gap_doubles_the_distance(self):
        points = face_points()
        near = head_position(landmarks(points), W, H)
        far = head_position(landmarks((points - [320, 240]) * .5 + [320, 240]), W, H)
        self.assertAlmostEqual(far[2], 2 * near[2], places=6)

    def test_sideways_motion_is_in_meters_and_points_to_the_users_right(self):
        points = face_points()
        _, _, z = head_position(landmarks(points), W, H)
        x = head_position(landmarks(points + [60, 0]), W, H)[0]
        self.assertAlmostEqual(x, 60 / FOCAL * z, places=6)
        self.assertGreater(x, 0)

    def test_closed_eyes_still_give_a_head_position(self):
        self.assertIsNone(__import__("tracker.gaze", fromlist=["eye_features"]).eye_features(
            landmarks(face_points(closed=True)), W, H))
        self.assertIsNotNone(head_position(landmarks(face_points(closed=True)), W, H))

    def test_turning_the_head_does_not_read_as_moving_away(self):
        points = face_points()
        center = np.array([320., 220.])
        turned = (points - center) * [math.cos(math.radians(30)), 1] + center  # eye gap foreshortened by a 30 degree turn
        naive = head_position(landmarks(turned), W, H)[2]
        corrected = head_position(landmarks(turned), W, H, yaw_axis_z=math.sin(math.radians(30)))[2]
        straight = head_position(landmarks(points), W, H)[2]
        self.assertGreater(naive, straight * 1.1)
        self.assertAlmostEqual(corrected, straight, delta=straight * .005)

    def test_implausible_or_tiny_faces_are_rejected(self):
        points = face_points()
        self.assertIsNone(head_position(landmarks((points - [320, 240]) * .05 + [320, 240]), W, H))  # too small
        self.assertIsNone(head_position(landmarks((points - [320, 240]) * 6 + [320, 240]), W, H))  # absurdly close
        self.assertIsNone(head_position(landmarks(points[:100]), W, H))
        bad = points.copy()
        bad[33] = [np.nan, 0]
        self.assertIsNone(head_position(landmarks(bad), W, H))

    def test_extreme_turn_is_clamped_instead_of_exploding(self):
        # Correction is capped at YAW_LIMIT, so a sideways profile can't divide by ~0 and fling the head away.
        points = (face_points() - [320, 240]) * .6 + [320, 240]  # farther away so the capped result stays in range
        capped = head_position(landmarks(points), W, H, yaw_axis_z=1.0)
        at_limit = head_position(landmarks(points), W, H, yaw_axis_z=0.8)
        self.assertIsNotNone(capped)
        self.assertEqual(list(capped), list(at_limit))


class HeadRotationTests(unittest.TestCase):
    def test_identity_is_no_rotation(self):
        quat, yaw_axis_z = head_rotation(np.eye(4))
        np.testing.assert_allclose(quat, [0, 0, 0, 1], atol=1e-9)
        self.assertAlmostEqual(yaw_axis_z, 0.0)

    def test_yaw_reports_its_foreshortening_axis_and_a_unit_quaternion(self):
        quat, yaw_axis_z = head_rotation(transform(rotation_y(30)))
        self.assertAlmostEqual(abs(yaw_axis_z), math.sin(math.radians(30)), places=6)
        self.assertAlmostEqual(float(np.linalg.norm(quat)), 1.0, places=9)
        # Turning about the camera's vertical axis stays a rotation about y (sign flips with the y-down frame).
        self.assertAlmostEqual(abs(quat[1]), math.sin(math.radians(15)), places=6)
        self.assertAlmostEqual(quat[0], 0.0, places=9)
        self.assertAlmostEqual(quat[2], 0.0, places=9)

    def test_uniform_scale_in_the_matrix_is_ignored(self):
        m = transform(rotation_y(20))
        m[:3, :3] *= 5.0  # MediaPipe's transform carries the face model's scale in centimeters
        quat, _ = head_rotation(m)
        self.assertAlmostEqual(float(np.linalg.norm(quat)), 1.0, places=9)
        np.testing.assert_allclose(quat, head_rotation(transform(rotation_y(20)))[0], atol=1e-9)

    def test_large_rotations_stay_valid(self):
        for degrees in (100, 150, 179):
            quat, _ = head_rotation(transform(rotation_y(degrees)))
            self.assertAlmostEqual(float(np.linalg.norm(quat)), 1.0, places=9)


if __name__ == "__main__":
    unittest.main()
