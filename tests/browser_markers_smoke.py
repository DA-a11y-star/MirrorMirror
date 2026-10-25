"""Optional real-Chrome marker check, without cameras or a running tracker.

Run: python tests/browser_markers_smoke.py [--artifacts EXISTING_DIRECTORY]
Checks actual page rendering, calibration-overlay visibility, viewport resize,
DPR changes, and OpenCV detection/projection of the browser-rendered patterns.
"""

import argparse
import asyncio
import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import cv2
import numpy as np
from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from tracker.glasses import screen_homography


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


async def check(endpoint, page_url, artifacts):
    with urllib.request.urlopen(endpoint + '/json/list') as response:
        targets = json.load(response)
    target = next(target for target in targets if target['type'] == 'page')
    async with connect(target['webSocketDebuggerUrl'], proxy=None, max_size=16 * 1024 * 1024) as socket:
        serial = 0

        async def call(method, params=None):
            nonlocal serial
            serial += 1
            await socket.send(json.dumps(dict(id=serial, method=method, params=params or {})))
            while True:
                message = json.loads(await socket.recv())
                if message.get('id') == serial:
                    assert 'error' not in message, message
                    return message.get('result', {})

        async def evaluate(expression):
            result = await call('Runtime.evaluate', dict(expression=expression, returnByValue=True, awaitPromise=True))
            assert 'exceptionDetails' not in result, result
            return result.get('result', {}).get('value')

        # Simulate the missing secure-context-only API on a guest's HTTP LAN origin.
        await call('Page.addScriptToEvaluateOnNewDocument', dict(source="Object.defineProperty(globalThis.crypto,'randomUUID',{value:undefined,configurable:true})"))
        await call('Page.navigate', dict(url=page_url + '/?tracker=mock'))
        for _ in range(100):
            if await evaluate('Boolean(window.app?.screenMarkers)'):
                break
            await asyncio.sleep(.1)
        else:
            raise AssertionError('Application did not initialize in Chrome')
        await evaluate("window.app.gazeUI.source.value='glasses';window.app.gazeUI.source.dispatchEvent(new Event('change'));true")
        previous = None
        detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50))
        for width, height, dpr in [(1280, 800, 1), (1920, 1080, 2), (800, 1200, 1)]:
            await call('Emulation.setDeviceMetricsOverride', dict(width=width, height=height, deviceScaleFactor=dpr, mobile=False))
            await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            await evaluate('window.app.gazeUI.start();true')
            layout = await evaluate('window.app.screenMarkers.layout')
            assert layout['width'] == width and layout['height'] == height, layout
            assert previous != layout['id'], 'resize did not change the layout revision'
            previous = layout['id']
            visible = await evaluate("(()=>{const b=document.getElementById('calibrate');const r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id})()")
            # Calibration overlay owns the page during a run; the marker layer is pointer-transparent.
            assert visible != 'screen-markers', visible
            screenshot = await call('Page.captureScreenshot', dict(format='png', captureBeyondViewport=False))
            image = cv2.imdecode(np.frombuffer(base64.b64decode(screenshot['data']), np.uint8), cv2.IMREAD_COLOR)
            h, w = image.shape[:2]
            corners, ids, _ = detector.detectMarkers(image)
            assert ids is not None and set(ids.ravel()) == {10, 11, 12, 13}, f'Cannot detect all markers at {width}x{height}@{dpr}'
            matrix = screen_homography(corners, ids, w, h, layout=layout)
            assert matrix is not None, 'Rendered marker coordinates do not match the transmitted layout'
            transform = np.array(matrix).reshape(3, 3)
            for point in [[.1, .2], [.5, .5], [.8, .9]]:
                mapped = transform @ [*point, 1]
                np.testing.assert_allclose(mapped[:2] / mapped[2], point, atol=.005)
            if artifacts:
                cv2.imwrite(str(artifacts / f'browser-markers-{width}-{height}-dpr{dpr}.png'), image)
            await evaluate('window.app.gazeUI.cancel();true')
            print(f'PASS: {width}x{height}, DPR {dpr}, all four markers visible through calibration overlay', flush=True)
        await evaluate("window.app.gazeUI.source.value='pointer';window.app.gazeUI.source.dispatchEvent(new Event('change'));true")
        assert await evaluate("document.getElementById('screen-markers').hidden"), 'markers remain visible after leaving glasses mode'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chrome', default='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    parser.add_argument('--artifacts', type=Path)
    parser.add_argument('--temp-dir', type=Path)
    args = parser.parse_args()
    chrome = args.chrome if Path(args.chrome).exists() else shutil.which('chromium') or shutil.which('google-chrome')
    if not chrome:
        parser.error('Chrome/Chromium not found; specify --chrome')
    if args.artifacts and not args.artifacts.is_dir():
        parser.error('--artifacts must name an existing directory')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT / 'web')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='mirror-markers-', dir=args.temp_dir) as profile:
            process = subprocess.Popen([chrome, '--headless=new', '--remote-debugging-port=0',
                                        f'--user-data-dir={profile}', '--no-first-run', '--use-angle=swiftshader',
                                        '--enable-unsafe-swiftshader', 'about:blank'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                port_file = Path(profile) / 'DevToolsActivePort'
                for _ in range(150):
                    if port_file.exists():
                        break
                    if process.poll() is not None:
                        raise RuntimeError('Chrome exited before exposing DevTools')
                    time.sleep(.1)
                port = port_file.read_text().splitlines()[0]
                asyncio.run(check(f'http://127.0.0.1:{port}', f'http://127.0.0.1:{server.server_port}', args.artifacts))
            finally:
                process.terminate()
                process.wait(timeout=10)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
