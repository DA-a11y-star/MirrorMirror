"""Assign identical USB cameras by preview: python -m tracker.camera_setup.

macOS device IDs are persisted; numeric indexes are resolved again on each launch.
Native AVFoundation capture opens the saved device ID directly, without relying
on OpenCV's potentially different enumeration order.
"""

import argparse
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np

CONFIG_PATH = Path(__file__).resolve().parent.parent / ".camera-config.json"
ROLES = ("eye", "scene", "webcam")


def list_devices():
    if sys.platform != "darwin":
        raise RuntimeError("Automatic device-ID assignment currently supports macOS. Use explicit camera indexes elsewhere.")
    from AVFoundation import AVCaptureDevice, AVMediaTypeVideo

    return [dict(index=i, name=str(device.localizedName()), uid=str(device.uniqueID()))
            for i, device in enumerate(AVCaptureDevice.devicesWithMediaType_(AVMediaTypeVideo))]


def resolve_config(config, devices):
    resolved = {}
    for role in ROLES:
        setting = config.get(role, {})
        matches = [device for device in devices if device["uid"] == setting.get("uid")]
        if len(matches) != 1:
            raise ValueError(f"Assigned {role} camera is missing. Run python -m tracker.camera_setup again.")
        rotation = setting.get("rotation", 0)
        if rotation not in (0, 90, 180, 270):
            raise ValueError(f"Invalid {role} camera rotation")
        roi = setting.get('roi')
        if roi is not None:
            if not isinstance(roi, list) or len(roi) != 4 or not all(isinstance(v, (int, float)) for v in roi):
                raise ValueError('Invalid eye ROI; run camera_setup again')
            x, y, w, h = roi
            if not (0 <= x < 1 and 0 <= y < 1 and w > 0 and h > 0 and x + w <= 1 and y + h <= 1):
                raise ValueError('Eye ROI must lie inside the oriented camera image')
        resolved[role] = dict(index=matches[0]["index"], uid=matches[0]['uid'], rotation=rotation, roi=roi)
    if len({value["index"] for value in resolved.values()}) != 3:
        raise ValueError("Eye, scene and webcam must be three different devices")
    return resolved


def load_assignments(path=CONFIG_PATH):
    if not path.exists():
        raise ValueError("Assign your cameras first: python -m tracker.camera_setup")
    return resolve_config(json.loads(path.read_text()), list_devices())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="List device indexes and persistent IDs without opening them")
    parser.add_argument('--probe', action='store_true', help='Capture all three cameras for 8 seconds and print diagnostics')
    parser.add_argument('--snapshots', type=Path, help='With --probe, save one diagnostic image per camera to this existing directory')
    args = parser.parse_args()
    devices = list_devices()
    for device in devices:
        print(f"{device['index']}: {device['name']} [{device['uid']}]")
    if args.list:
        return
    # Do not activate a Continuity/iPhone camera just because it is advertised.
    candidates = [d for d in devices if "innomaker" in d["name"].lower() or "facetime" in d["name"].lower()]
    if len(candidates) < 3:
        raise SystemExit("Connect both Innomaker cameras and the laptop webcam, then retry.")
    from tracker.mac_capture import MacCameraCapture
    cameras = [MacCameraCapture(d['uid'], role=f"setup-{d['index']}") for d in candidates]
    config, selected = {}, 0
    window = "Camera assignment: select feed, then E / S / W"
    try:
        for camera in cameras:
            camera.start()
        if args.probe:
            time.sleep(8)
            failed = False
            for device, camera in zip(candidates, cameras):
                _, captured = camera.frames.get()
                failed |= captured is None or camera.error is not None
                print(json.dumps(dict(index=device['index'], uid=device['uid'], frames=camera.count,
                                      age_ms=round((time.monotonic() - captured[0]) * 1000) if captured else None,
                                      shape=list(captured[1].shape) if captured else None,
                                      error=str(camera.error) if camera.error else None)), flush=True)
                if captured and args.snapshots:
                    path = args.snapshots / f"camera-{device['index']}.jpg"
                    if not cv2.imwrite(str(path), captured[1]):
                        raise RuntimeError(f'Could not save diagnostic snapshot {path}')
            if failed:
                raise SystemExit('One or more cameras did not deliver frames; check camera permissions and other camera apps.')
            return
        while True:
            tiles = []
            for i, (device, camera) in enumerate(zip(candidates, cameras)):
                _, captured = camera.frames.get()
                tile = np.zeros((300, 480, 3), np.uint8)
                if captured:
                    tile[:270] = cv2.resize(captured[1], (480, 270))
                title = f"{i + 1}: index {device['index']} {device['name']}"
                cv2.putText(tile, title, (8, 290), cv2.FONT_HERSHEY_SIMPLEX, .45, (255, 255, 255), 1)
                if i == selected:
                    cv2.rectangle(tile, (1, 1), (478, 298), (0, 220, 255), 3)
                if camera.error:
                    raise camera.error
                tiles.append(tile)
            canvas = np.vstack(tiles)
            text = "1/2/3 select | E eye | S forward | W webcam | R rotate | I eye ROI | Enter save"
            cv2.putText(canvas, text, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, .43, (0, 220, 255), 1)
            assigned = "  ".join(f"{role}={value['index']} ({value['rotation']} deg)" for role, value in config.items())
            cv2.putText(canvas, assigned, (8, 45), cv2.FONT_HERSHEY_SIMPLEX, .48, (0, 220, 255), 1)
            cv2.imshow(window, canvas)
            key = cv2.waitKey(20) & 0xff
            if ord('1') <= key < ord('1') + len(candidates):
                selected = key - ord('1')
            if key == ord('r'):
                camera = cameras[selected]
                camera.rotation = (camera.rotation + 90) % 360
                for value in config.values():
                    if value['index'] == candidates[selected]['index']:
                        value['rotation'] = camera.rotation
                        value.pop('roi', None)
            if key in (ord('e'), ord('s'), ord('w')):
                role = {ord('e'): 'eye', ord('s'): 'scene', ord('w'): 'webcam'}[key]
                config[role] = {**candidates[selected], "rotation": cameras[selected].rotation}
                print(f"Assigned {role}: {config[role]}", flush=True)
            if key == ord('i'):
                eye = config.get('eye')
                if eye is None or eye['index'] != candidates[selected]['index']:
                    print('Assign the selected camera as E (eye) before selecting its ROI.', flush=True)
                    continue
                _, captured = cameras[selected].frames.get()
                if captured:
                    image = captured[1]
                    x, y, w, h = cv2.selectROI('Select eye only, then Enter', image, showCrosshair=True)
                    cv2.destroyWindow('Select eye only, then Enter')
                    if w and h:
                        height, width = image.shape[:2]
                        eye['roi'] = [x / width, y / height, w / width, h / height]
                        print(f"Saved eye ROI: {eye['roi']}", flush=True)
            if key in (10, 13):
                try:
                    resolve_config(config, devices)
                except ValueError as exc:
                    print(exc, flush=True)
                    continue
                CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n")
                print(f"Saved {CONFIG_PATH}. Run python -m tracker.main --gaze glasses", flush=True)
                break
            if key == 27 or cv2.getWindowProperty(window, cv2.WND_PROP_VISIBLE) < 1:
                break
    finally:
        for camera in cameras:
            camera.stop_event.set()
        for camera in cameras:
            camera.stop()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
