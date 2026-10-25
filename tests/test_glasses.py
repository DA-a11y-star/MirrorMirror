import asyncio
import json
import time
import unittest
from types import SimpleNamespace

import cv2
import numpy as np
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from tracker.camera_setup import resolve_config
from tracker.capture import LatestValue
from tracker.glasses import MAX_AGE, MAX_SKEW, GlassesWorker, ObservationHistory, detect_pupil, screen_homography, valid_screen_layout
from tracker.main import TrackerServer


def browser_layout(width=1200, height=800):
    cell = max(4, int(min(width, height) * .15 / 6))
    side, inset = cell * 6, 8 + cell
    positions = [(inset, inset), (width - inset - side, inset),
                 (width - inset - side, height - inset - side), (inset, height - inset - side)]
    return dict(version=1, id='test-layout', width=width, height=height, markers=[
        dict(id=10 + i, corners=[[x / width, y / height], [(x + side) / width, y / height],
                                [(x + side) / width, (y + side) / height], [x / width, (y + side) / height]])
        for i, (x, y) in enumerate(positions)])


def browser_board(layout):
    width, height = layout['width'], layout['height']
    viewport = np.full((height, width), 220, np.uint8)
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    for marker in layout['markers']:
        x, y = np.rint(np.array(marker['corners'][0]) * [width, height]).astype(int)
        size = round((marker['corners'][1][0] - marker['corners'][0][0]) * width)
        viewport[y - 20:y + size + 20, x - 20:x + size + 20] = 255
        viewport[y:y + size, x:x + size] = cv2.aruco.generateImageMarker(dictionary, marker['id'], size)
    return viewport


class GlassesTests(unittest.TestCase):
    def test_browser_layout_validation_and_connection_ownership(self):
        layout = browser_layout()
        self.assertIsNotNone(valid_screen_layout(layout))
        self.assertIsNone(valid_screen_layout({**layout, 'width': float('nan')}))
        self.assertIsNone(valid_screen_layout({**layout, 'markers': layout['markers'][:3]}))
        bad = json.loads(json.dumps(layout))
        bad['markers'][0]['corners'][0][0] = -1
        self.assertIsNone(valid_screen_layout(bad))
        camera = SimpleNamespace(frames=LatestValue(), error=None)
        worker = GlassesWorker(camera, camera)
        first, second = object(), object()
        self.assertTrue(worker.set_screen_layout(layout, owner=first))
        worker.poses.put(time.monotonic(), {'matrix': [1]})
        self.assertTrue(worker.set_screen_layout({**layout, 'id': 'resized'}, owner=second))
        self.assertEqual(len(worker.poses.values), 0)
        worker.release_screen_layout(first)
        self.assertEqual(worker.screen_layout()[0]['id'], 'resized')
        worker.release_screen_layout(second)
        self.assertIsNone(worker.screen_layout()[0])

    def test_browser_markers_project_viewport_under_perspective(self):
        layout = browser_layout()
        viewport = browser_board(layout)
        dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        quad = np.float32([[150, 70], [1140, 110], [1050, 650], [90, 600]])
        to_camera = cv2.getPerspectiveTransform(np.float32([[0, 0], [1200, 0], [1200, 800], [0, 800]]), quad)
        scene = cv2.warpPerspective(viewport, to_camera, (1280, 720))
        corners, ids, _ = cv2.aruco.ArucoDetector(dictionary).detectMarkers(scene)
        self.assertEqual(set(ids.ravel()), {10, 11, 12, 13})
        matrix = screen_homography(corners, ids, 1280, 720, layout=layout)
        self.assertIsNotNone(matrix)
        for target in [[.5, .5], [.1, .8], [.9, .2]]:
            camera_point = to_camera @ [target[0] * 1200, target[1] * 800, 1]
            camera_point /= camera_point[2]
            prediction = np.array(matrix).reshape(3, 3) @ [camera_point[0] / 1280, camera_point[1] / 720, 1]
            np.testing.assert_allclose(prediction[:2] / prediction[2], target, atol=.006)
        shifted = [c.copy() for c in corners]
        shifted[0] += [35, -25]
        self.assertIsNone(screen_homography(shifted, ids, 1280, 720, layout=layout))

    def test_identical_names_resolve_by_id_after_device_order_changes(self):
        config = {role: dict(uid=uid, rotation=0) for role, uid in
                  [('eye', 'usb-left'), ('scene', 'usb-right'), ('webcam', 'builtin')]}
        devices = [dict(index=i, name='same name', uid=uid)
                   for i, uid in enumerate(['usb-right', 'builtin', 'usb-left'])]
        result = resolve_config(config, devices)
        self.assertEqual([result[role]['index'] for role in ['eye', 'scene', 'webcam']], [2, 0, 1])
        config['scene']['uid'] = 'usb-left'
        with self.assertRaisesRegex(ValueError, 'different devices'):
            resolve_config(config, devices)
        config['scene']['uid'] = 'disconnected'
        with self.assertRaisesRegex(ValueError, 'missing'):
            resolve_config(config, devices)

    def test_pupil_center_survives_glint_and_roi_excludes_dark_distractor(self):
        image = np.full((240, 320, 3), 190, np.uint8)
        cv2.ellipse(image, ((160, 120), (52, 36), 20), (10, 10, 10), -1)
        cv2.circle(image, (164, 116), 3, (255, 255, 255), -1)
        cv2.circle(image, (40, 40), 25, (0, 0, 0), -1)
        pupil = detect_pupil(image, [.25, .25, .5, .5])
        self.assertIsNotNone(pupil)
        np.testing.assert_allclose(pupil['features'][:2], [.5, .5], atol=.01)
        self.assertGreater(pupil['conf'], .5)
        self.assertIsNone(detect_pupil(np.full_like(image, 100)))
        self.assertIsNone(detect_pupil(np.zeros_like(image)))

    def test_clipped_pupil_is_rejected(self):
        image = np.full((240, 320, 3), 190, np.uint8)
        cv2.circle(image, (0, 120), 30, (5, 5, 5), -1)
        self.assertIsNone(detect_pupil(image))

    def test_large_dark_iris_cannot_outscore_its_darker_nested_pupil(self):
        image = np.full((240, 320, 3), 190, np.uint8)
        cv2.ellipse(image, ((160, 120), (130, 100), 15), (55, 55, 55), -1)
        cv2.ellipse(image, ((164, 122), (50, 35), 15), (15, 15, 15), -1)
        pupil = detect_pupil(image)
        self.assertIsNotNone(pupil)
        self.assertLess(max(pupil['ellipse'][1]), 70, 'must fit the pupil, not the iris')
        np.testing.assert_allclose(pupil['ellipse'][0], [164, 122], atol=2)

    def test_missing_duplicate_and_mirrored_markers_are_rejected(self):
        layout = browser_layout()
        image = browser_board(layout)
        dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
        corners, ids, _ = cv2.aruco.ArucoDetector(dictionary).detectMarkers(image)
        self.assertEqual(len(ids), 4)
        self.assertIsNone(screen_homography(corners, ids, 1200, 800))
        self.assertIsNone(screen_homography(corners[:3], ids[:3], 1200, 800, layout))
        self.assertIsNone(screen_homography([*corners, corners[0]], np.append(ids.ravel(), ids.ravel()[0]), 1200, 800, layout))
        # A mirrored screen would silently reverse gaze unless rejected.
        mirrored = [c.copy() for c in corners]
        for corner in mirrored:
            corner[..., 0] = 1200 - corner[..., 0]
        self.assertIsNone(screen_homography(mirrored, ids, 1200, 800, layout))

    def test_history_rejects_skew_staleness_and_failed_detection(self):
        history = ObservationHistory(capacity=2)
        history.put(1, 'valid')
        self.assertEqual(history.nearest(1.01, 1.02), (1, 'valid'))
        self.assertIsNone(history.nearest(1 + MAX_SKEW + .01, 1 + MAX_SKEW + .01))
        self.assertIsNone(history.nearest(1, 1 + MAX_AGE + .01))
        history.put(1.02, None)
        self.assertEqual(history.nearest(1.02, 1.03), (1.02, None))
        history.put(1.04, 'new')
        self.assertEqual(len(history.values), 2)

    def test_worker_pipeline_invalidates_gaze_when_markers_disappear(self):
        eye = SimpleNamespace(frames=LatestValue(), error=None)
        scene = SimpleNamespace(frames=LatestValue(), error=None)
        pupil = np.full((240, 320, 3), 190, np.uint8)
        cv2.ellipse(pupil, ((160, 120), (52, 36), 20), (10, 10, 10), -1)
        layout = browser_layout()
        board = browser_board(layout)
        worker = GlassesWorker(eye, scene)
        worker.set_screen_layout(layout)
        worker.start()
        try:
            for expected_valid, image in [(True, board), (False, np.full_like(board, 255))]:
                deadline = time.monotonic() + 2
                matched = False
                while time.monotonic() < deadline:
                    stamp = time.monotonic()
                    scene.frames.put((stamp, image))
                    eye.frames.put((stamp, pupil))
                    time.sleep(.04)
                    packet = worker.latest()
                    if (packet['conf'] > .5) == expected_valid:
                        matched = True
                        json.dumps(packet, allow_nan=False)
                        break
                self.assertTrue(matched, packet)
                self.assertIsNone(worker.error)
        finally:
            worker.stop()


class IndependentGazeTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_layout_reaches_worker_and_disconnect_releases_only_its_owner(self):
        camera = SimpleNamespace(frames=LatestValue(), error=None)
        worker = GlassesWorker(camera, camera)
        server = await serve(TrackerServer(LatestValue(), worker).handle, '127.0.0.1', 0)
        url = f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}'
        try:
            async with connect(url, proxy=None) as first:
                await first.send(json.dumps(dict(type='screen_layout', layout=browser_layout())))
                async def wait_for_layout(client, name):
                    for _ in range(50):
                        packet = json.loads(await asyncio.wait_for(client.recv(), 1))
                        if packet.get('gaze', {}).get('screen_layout') == name:
                            return
                    self.fail('layout not reflected in gaze stream')
                await wait_for_layout(first, 'test-layout')
                async with connect(url, proxy=None) as second:
                    await second.send(json.dumps(dict(type='screen_layout', layout={**browser_layout(), 'id': 'second'})))
                    await wait_for_layout(second, 'second')
                    await first.close()
                    await asyncio.sleep(.05)
                    self.assertEqual(worker.screen_layout()[0]['id'], 'second')
            await asyncio.sleep(.05)
            self.assertIsNone(worker.screen_layout()[0])
        finally:
            server.close()
            await server.wait_closed()

    async def test_gaze_streams_without_hand_frames_and_cannot_replay_hands(self):
        frames = LatestValue()
        packet = dict(source='glasses', t=time.monotonic(), conf=0, status='markers missing')

        class Gaze:
            def latest(self):
                return packet

        server = await serve(TrackerServer(frames, Gaze()).handle, '127.0.0.1', 0)
        try:
            url = f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}'
            async with connect(url, proxy=None) as client:
                message = json.loads(await asyncio.wait_for(client.recv(), 1))
                self.assertEqual(message['type'], 'gaze')
                self.assertNotIn('hands', message)
                with self.assertRaises(TimeoutError):
                    await asyncio.wait_for(client.recv(), .05)
                packet['t'] = time.monotonic()
                message = json.loads(await asyncio.wait_for(client.recv(), 1))
                self.assertEqual(message['gaze']['t'], packet['t'])
        finally:
            server.close()
            await server.wait_closed()


if __name__ == '__main__':
    unittest.main()
