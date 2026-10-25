"""End-to-end check of multiplayer: two headless Chromes (users A and B) + the real relay + mock trackers, with the
pointer as gaze, then a mouse-only user (?tracker=mouse). Run from anywhere: python tests/e2e/run.py

Needs Chrome: set CHROME, or have google-chrome / chromium on PATH, or the macOS app installed. Without one it skips
(exit 0). Screenshots and logs are kept only on failure, or
under E2E_OUT when that is set.
"""
import asyncio, base64, functools, json, math, os, platform, shutil, subprocess, sys, tempfile, threading, time, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from relay.relay import SERVER_OPTIONS, Relay
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
LINUX = platform.system() == 'Linux'


def find_chrome():
    for candidate in (os.environ.get('CHROME'), *map(shutil.which, ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome')), MAC_CHROME):
        if candidate and Path(candidate).exists():
            return candidate


CHROME = find_chrome()
OUT = Path(os.environ['E2E_OUT']) if os.environ.get('E2E_OUT') else Path(tempfile.mkdtemp(prefix='e2e-'))
OUT.mkdir(exist_ok=True)


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


class Page:
    def __init__(self, name, url):
        self.name, self.url, self.errors, self.counter = name, url, [], 0

    async def start(self):
        self.profile = tempfile.mkdtemp(prefix=f'profile-{self.name}-', dir=OUT)
        self.log = open(OUT / f'chrome-{self.name}.log', 'w')
        self.proc = subprocess.Popen([
            CHROME, '--headless=new', '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader',
            '--use-angle=swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0',
            *(['--no-sandbox', '--disable-dev-shm-usage'] if LINUX else []),
            f'--user-data-dir={self.profile}', '--window-size=900,640', self.url], stdout=self.log, stderr=self.log)
        active = Path(self.profile) / 'DevToolsActivePort'
        for _ in range(150):
            if active.exists(): break
            await asyncio.sleep(.1)
        port = int(active.read_text().splitlines()[0])
        tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
        page = next(t for t in tabs if t['type'] == 'page')
        self.ws = await connect(page['webSocketDebuggerUrl'], proxy=None, max_size=16_000_000)
        await self.call('Runtime.enable')

    async def call(self, method, params=None):
        self.counter += 1
        await self.ws.send(json.dumps(dict(id=self.counter, method=method, params=params or {})))
        while True:
            msg = json.loads(await asyncio.wait_for(self.ws.recv(), 20))
            if msg.get('method') == 'Runtime.exceptionThrown': self.errors.append(msg['params']['exceptionDetails'])
            if msg.get('id') == self.counter:
                if 'error' in msg: raise RuntimeError(msg['error'])
                return msg['result']

    async def js(self, expression):
        r = await self.call('Runtime.evaluate', dict(expression=expression, returnByValue=True, awaitPromise=True))
        if 'exceptionDetails' in r: raise RuntimeError(f'{self.name}: {r["exceptionDetails"]}')
        return r['result'].get('value')

    async def wait(self, expression, seconds=20, what=None):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if await self.js(expression): return True
            await asyncio.sleep(.1)
        await self.shot(f'fail-{self.name}.png')
        raise AssertionError(f'{self.name}: timed out waiting for {what or expression}; errors={self.errors}')

    async def shot(self, name):
        r = await self.call('Page.captureScreenshot', {'format': 'png'})
        (OUT / name).write_bytes(base64.b64decode(r['data']))

    async def look_at_block(self, block_id):
        x, y = await self.js(f"""(() => {{
          const b = app.blocks.children.find(b => b.userData.id === '{block_id}');
          const p = b.getWorldPosition(new app.camera.position.constructor()).project(app.view);
          return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight];
        }})()""")
        await self.call('Input.dispatchMouseEvent', dict(type='mouseMoved', x=x, y=y))
        return x, y

    def pos(self, block_id):
        return self.js(f"app.blocks.children.find(b => b.userData.id === '{block_id}').position.toArray()")

    async def close(self):
        await self.ws.close()
        self.proc.terminate()
        try:
            self.proc.wait(10)  # Chrome writes to its profile until it exits; don't delete the directory under it
        except subprocess.TimeoutExpired:
            self.proc.kill()


def dist(a, b): return math.dist(a, b)


# A voice-made object, as the host's scenes carry it: a recipe the first time, poses only after that.
ASSEMBLY = dict(version=1, id='generated-e2e-1', name='e2e stool', position=[1.2, 0, -1], quaternion=[0, 0, 0, 1], parts=[
    dict(id='seat', shape='box', size=[.4, .1, .4], position=[0, .4, 0], quaternion=[0, 0, 0, 1], color='#4c6ef5'),
    dict(id='leg', shape='cylinder', size=[.1, .4, .1], position=[0, .2, 0], quaternion=[0, 0, 0, 1], color='#a16b42')])

# Pages start in MOVE mode, where open palms steer and pinch does nothing. Grabbing needs EDIT (the M key).
EDIT = "app.gestures.mode === 'EDIT' || app.gestures.toggleMode(); 0"

# Stop looking at anything and forget the current target, so the mock hands' next pinch grabs nothing.
QUIET = 'app.gaze.pointer = null; app.interaction.resetTargeting(); 0'


async def main():
    relay_server = await serve(Relay().handle, '127.0.0.1', 0, **SERVER_OPTIONS)
    relay_port = relay_server.sockets[0].getsockname()[1]
    http = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT / 'web')))
    threading.Thread(target=http.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{http.server_port}/?relay=ws://127.0.0.1:{relay_port}&tracker=mock&preset=workshop'
    a, b = Page('A', base + '&user=A'), Page('B', base + '&user=B')
    extra = []
    await asyncio.gather(a.start(), b.start())
    try:
        for p in (a, b):
            await p.wait('window.app?.net?.status === "connected"', what='relay connection')
            await p.js('app.renderer.setPixelRatio(1); app.renderer.shadowMap.enabled = false; 0')
            await p.js(EDIT)
        await a.wait('[...app.peers.values()].some(p => p.live)', what='A sees B')
        await b.wait('[...app.peers.values()].some(p => p.live)', what='B sees A')
        print('PASS: both laptops connect through the relay and see each other')

        # Seats and avatars: each sees the other at the far end, facing them, with hands.
        cam_a, cam_b = await a.js('app.camera.position.toArray()'), await b.js('app.camera.position.toArray()')
        assert cam_a[2] > 2 and cam_b[2] < -2, (cam_a, cam_b)
        await a.wait("app.peers.get('B').live", what='B avatar live on A'); await b.wait("app.peers.get('A').live", what='A avatar live on B')
        seen_b = await a.js("app.peers.get('B').body.root.position.toArray()")   # feet
        seen_a = await b.js("app.peers.get('A').body.root.position.toArray()")
        eye_b = await a.js("app.peers.get('B').seat.position.toArray()")
        floor_b = await a.js("app.world?.floorAt(...[app.peers.get('B').body.root.position.x, app.peers.get('B').body.root.position.z]) ?? 0")
        assert abs(seen_b[2] - cam_b[2]) < .3 and abs(seen_a[2] - cam_a[2]) < .3 and abs(seen_b[1] - floor_b) < .1 and 1.3 < eye_b[1] - seen_b[1] < 1.6, (seen_b, cam_b, seen_a, cam_a, eye_b, floor_b)
        face_b = await a.js("(() => { const v = new app.camera.position.constructor(0, 0, -1).applyQuaternion(app.peers.get('B').body.head.quaternion); return v.z; })()")
        assert face_b > .3, f'B faces away from A: {face_b}'
        await a.wait("app.peers.get('B').hands.joints.count === 42", what="B's hands appear on A")
        await b.wait("app.peers.get('A').hands.joints.count === 42", what="A's hands appear on B")
        print(f'PASS: A at z={cam_a[2]:.1f} sees B at z={seen_b[2]:.1f} facing it (z {face_b:.2f}); B sees A at z={seen_a[2]:.1f}; both draw 2 remote hands')
        await a.shot('A-sees-B.png'); await b.shot('B-sees-A.png')

        # B looks at b2 -> A shows B's gaze highlight.
        await b.look_at_block('b2')
        await b.wait("app.interaction.target?.userData.id === 'b2'", what='B targets b2')
        await a.wait("app.peers.get('B').looking === 'b2' && app.interaction.remote.looking.has('b2')", what="A sees B's gaze on b2")
        print("PASS: B's gaze target b2 shows up on A")

        # B grabs b2 (mock pinch) -> A follows, and A cannot take it.
        start = await b.pos('b2')
        await b.wait("app.interaction.grabs.size > 0", seconds=20, what='B grabs b2')
        await a.wait("app.sync.holders.get('b2') === 'B'", what='A knows B holds b2')
        await a.look_at_block('b2')
        worst, samples, a_target = 0, 0, set()
        while await b.js('app.interaction.grabs.size > 0'):
            pa, pb = await a.pos('b2'), await b.pos('b2')
            worst, samples = max(worst, dist(pa, pb)), samples + 1
            a_target.add(await a.js('app.interaction.target?.userData.id ?? null'))
            await asyncio.sleep(.1)
        # The mock hands pinch every few seconds: stop looking at blocks so nothing is grabbed again.
        # (Its second hand pinches ~0.26 s after the first lets go, inside the 0.3 s target grace period.)
        await asyncio.gather(a.js(QUIET), b.js(QUIET))
        await asyncio.gather(b.wait('app.interaction.grabs.size === 0', what='B done holding'), a.wait('app.interaction.grabs.size === 0', what='A done holding'))
        moved = dist(await b.pos('b2'), start)
        assert samples >= 3 and moved > .05, (samples, moved)
        assert 'b2' not in a_target, f'A could target a block B was holding: {a_target}'
        # Looking at b2 snaps to its neighbour b1 instead, which A may legitimately grab: only b2 is off limits.
        assert await a.js("[...app.interaction.grabs.values()].every(g => g.mesh.userData.id !== 'b2')")
        print(f'PASS: while B held b2 ({samples} samples, block moved {moved:.2f} m) A followed within {worst:.3f} m and could not target it')

        # Release: the block settles on the same pose everywhere and does not jump back afterwards.
        await a.wait("app.sync.holders.size === 0", what='A frees b2')
        await asyncio.sleep(.8)
        final_b = await b.pos('b2')
        drift, trace = 0, []
        for _ in range(12):
            drift = max(drift, dist(await b.pos('b2'), final_b))
            trace.append(await b.js("[app.interaction.grabs.size, app.sync.targets.size, app.interaction.target?.userData.id ?? null, app.tracker.lastGesture]"))
            await asyncio.sleep(.1)
        if drift >= .01: print('DIAG B after release [grabs, sync targets, target, last gesture]:', trace)
        gap = dist(await a.pos('b2'), await b.pos('b2'))
        assert gap < .01 and drift < .01, (gap, drift)
        print(f'PASS: after release A and B agree within {gap*1000:.1f} mm and B saw no jump-back ({drift*1000:.1f} mm)')

        # Host -> guest: A grabs b4, B follows (via A's held stream), then the host scene settles it.
        await a.look_at_block('b4')
        await a.wait("app.interaction.target?.userData.id === 'b4'", what='A targets b4')
        start4 = await a.pos('b4')
        await a.wait("app.interaction.grabs.size > 0", what='A grabs b4')
        await b.wait("app.sync.holders.get('b4') === 'A'", what='B knows A holds b4')
        while await a.js('app.interaction.grabs.size > 0'):
            await asyncio.sleep(.1)
        await asyncio.gather(a.js(QUIET), b.js(QUIET))
        await a.wait('app.interaction.grabs.size === 0', what='A done holding')
        assert dist(await a.pos('b4'), start4) > .05
        await b.wait("app.sync.holders.size === 0", what='B frees b4')
        await asyncio.sleep(1.0)
        gap4 = dist(await a.pos('b4'), await b.pos('b4'))
        assert gap4 < .01, gap4
        print(f'PASS: A moved b4 and B shows it within {gap4*1000:.1f} mm')

        # Late join: a reloaded B gets the current scene from the host, not the starter layout.
        # Scenes carry poses only once everyone has the recipe, so the reloaded B must get the recipe again.
        await a.js(f"app.objects.add({json.dumps(ASSEMBLY)}, {{place: false}}); 0")
        await b.wait("app.sync.meshes.has('generated-e2e-1')", what='B builds the new object from the host scene')
        await a.wait('app.sync.needSpec.size === 0', what='the host has delivered every recipe and drops to pose-only scenes')
        moved_a = await a.pos('b4')
        await b.call('Page.reload')
        await b.wait('window.app?.net?.status === "connected"', what='B reconnects')
        await b.js(EDIT)
        await b.wait("app.sync.meshes.has('generated-e2e-1')", what='reloaded B rebuilds the object from a recipe')
        stool_a, stool_b = await a.js("app.sync.meshes.get('generated-e2e-1').position.toArray()"), await b.js("app.sync.meshes.get('generated-e2e-1').position.toArray()")
        assert dist(stool_a, stool_b) < .02, (stool_a, stool_b)
        await b.wait(f"Math.hypot(...app.blocks.children.find(b => b.userData.id === 'b4').position.toArray().map((v, i) => v - {json.dumps(moved_a)}[i])) < .02",
                     what='reloaded B catches up with the host scene')
        print('PASS: a reloaded B catches up to the host scene, including a voice object it had to rebuild from a recipe')

        # Walking: B holds the up arrow, A sees B's whole body walk toward it.
        z0 = (await a.js("app.peers.get('B').body.root.position.toArray()"))[2]
        await b.js("window.dispatchEvent(new KeyboardEvent('keydown', {code: 'ArrowUp', key: 'ArrowUp'})); 0")
        await asyncio.sleep(1.5)
        await b.js("window.dispatchEvent(new KeyboardEvent('keyup', {code: 'ArrowUp', key: 'ArrowUp'})); 0")
        await asyncio.sleep(.8)
        z_b = (await b.js("app.locomotion.state().pos"))[2]
        z_seen = (await a.js("app.peers.get('B').body.root.position.toArray()"))[2]
        assert z_b - z0 > .5 and abs(z_seen - z_b) < .05, (z0, z_b, z_seen)
        print(f'PASS: B walked {z_b - z0:.2f} m toward A and A shows it at the same place ({abs(z_seen - z_b) * 1000:.0f} mm apart)')

        # A peer that leaves disappears and releases anything it held.
        await b.close()
        await a.wait("![...app.peers.values()].some(p => p.live) && app.sync.holders.size === 0", seconds=10, what='B gone')
        print('PASS: when B closes, its avatar disappears from A')

        # No camera: a user on the mouse alone (?tracker=mouse). Cursor = gaze, left button = pinch.
        m = Page('M', base.replace('tracker=mock', 'tracker=mouse') + '&user=B')
        extra.append(m)
        await m.start()
        await m.wait('window.app?.net?.status === "connected"', what='mouse user connects')
        await m.js('app.renderer.setPixelRatio(1); app.renderer.shadowMap.enabled = false; 0')
        assert await m.js('app.tracker.status') == 'mouse'
        x, y = await m.look_at_block('b3')
        await m.wait("app.interaction.target?.userData.id === 'b3'", what='the cursor targets b3 as gaze')
        assert await m.js('app.interaction.grabs.size') == 0, 'looking alone must not grab'
        start3 = await m.pos('b3')
        await m.call('Input.dispatchMouseEvent', dict(type='mousePressed', x=x, y=y, button='left', buttons=1, clickCount=1))
        await m.wait('app.interaction.grabs.size === 1', what='the left button pinches and grabs b3')
        assert dist(await m.pos('b3'), start3) < .01, 'pressing must not jump the block'
        for i in range(1, 9):
            await m.call('Input.dispatchMouseEvent', dict(type='mouseMoved', x=x + i * 12, y=y, button='left', buttons=1))
            await asyncio.sleep(.1)
        moved3 = dist(await m.pos('b3'), start3)
        assert moved3 > .05, moved3
        await a.wait("app.sync.holders.get('b3') === 'B'", what='A sees the mouse user holding b3')
        await m.call('Input.dispatchMouseEvent', dict(type='mouseReleased', x=x + 96, y=y, button='left', buttons=0, clickCount=1))
        await m.wait('app.interaction.grabs.size === 0', what='releasing the button drops b3')
        await asyncio.sleep(1.0)
        dropped = await m.pos('b3')
        await m.call('Input.dispatchMouseEvent', dict(type='mouseMoved', x=x, y=y + 60))
        await asyncio.sleep(.3)
        assert dist(await m.pos('b3'), dropped) < .01, 'a released block stays put'
        gap3 = dist(await a.pos('b3'), dropped)
        assert gap3 < .02, gap3
        print(f'PASS: with the mouse alone, a click-drag moved b3 {moved3:.2f} m, A saw it, and the drop landed within {gap3*1000:.1f} mm')

        # A set with a model: the city loads as scenery. It must be impossible to target, grab or move.
        await m.close()
        # The host's mock hands keep pinching in EDIT mode and would keep nudging blocks; stop them so only C moves anything.
        await a.js("app.gestures.mode = 'MOVE'; app.interaction.releaseAll(); 0")
        c = Page('C', base.replace('tracker=mock', 'tracker=mouse') + '&user=B&set=cyberpunk')
        extra.append(c)
        await c.start()
        await c.wait('window.app?.net?.status === "connected"', what='city page connects')
        await c.js('app.renderer.setPixelRatio(1); app.renderer.shadowMap.enabled = false; 0')
        await c.js('app.setReady.then(() => 0)')
        stats = await c.js('(async () => { const m = await import("/scenery.js"); return m.sceneryStats(app.scenery); })()')
        assert stats['triangles'] == 64171 and stats['materials'] == 30 and stats['meshes'] >= 30, stats  # chunked into cells: more meshes than the file's 30
        assert await c.js('app.scenery.parent === app.scene && !app.blocks.children.some(o => o.userData.scenery)'), 'scenery must not be in blocks'
        assert await c.js("['b1','b2','b3','b4','b5'].every(id => app.blocks.children.some(o => o.userData.id === id))"), 'starter blocks exist'
        assert await c.js('app.blocks.position.x') == await c.js('app.set.workspace[0]'), 'the blocks sit at the set\'s workspace'
        assert await c.js('app.look.grid.visible') is False
        placed = await c.js('app.scenery.getWorldPosition(new app.camera.position.constructor()).toArray()')
        # A page that just joined is still easing its blocks to the host's poses; let that finish first.
        poses = 'JSON.stringify(app.blocks.children.map(o => o.position.toArray().map(v => Math.round(v * 1000))))'
        before, still = await c.js(poses), 0
        for _ in range(60):
            await asyncio.sleep(.3)
            now_poses = await c.js(poses)
            still = still + 1 if now_poses == before else 0
            before = now_poses
            if still >= 5: break  # unchanged for 1.5 s
        else:
            raise AssertionError('blocks never settled after joining')
        city = await c.js('''(() => { const box = new app.camera.position.constructor(); const p = box.set(0, .4, 0).project(app.view);
          return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight]; })()''')
        await c.call('Input.dispatchMouseEvent', dict(type='mouseMoved', x=city[0], y=city[1]))
        await asyncio.sleep(.8)
        assert await c.js('app.interaction.target') is None, 'looking at the city must not target anything'
        await c.call('Input.dispatchMouseEvent', dict(type='mousePressed', x=city[0], y=city[1], button='left', buttons=1, clickCount=1))
        for i in range(6):
            await c.call('Input.dispatchMouseEvent', dict(type='mouseMoved', x=city[0] + i * 15, y=city[1], button='left', buttons=1))
            await asyncio.sleep(.1)
        assert await c.js('app.interaction.grabs.size') == 0, 'pinching on the city must not grab it'
        await c.call('Input.dispatchMouseEvent', dict(type='mouseReleased', x=city[0] + 75, y=city[1], button='left', buttons=0, clickCount=1))
        after = await c.js(poses)
        assert after == before, f'no block moved either: {before} -> {after}; holders A={await a.js("JSON.stringify([...app.sync.holders])")} C={await c.js("JSON.stringify([...app.sync.holders])")}'
        moved = await c.js('app.scenery.getWorldPosition(new app.camera.position.constructor()).toArray()')
        assert max(abs(a - b) for a, b in zip(moved, placed)) < 1e-6, (placed, moved)
        print(f"PASS: the cyberpunk city loads as scenery ({stats['triangles']} triangles, {stats['meshes']} meshes) and cannot be targeted or grabbed")

        for p in (a, b, *extra):
            assert not p.errors, (p.name, p.errors)
        print('PASS: no JavaScript exceptions on either page')
    finally:
        for p in (a, b, *extra):
            try: await p.close()
            except Exception: pass
        relay_server.close()


if CHROME is None:
    shutil.rmtree(OUT, ignore_errors=True)
    print('SKIP: no Chrome found; set CHROME to its path')
    sys.exit(0)
try:
    asyncio.run(main())
except BaseException:
    print(f'e2e screenshots and Chrome logs kept in {OUT}', file=sys.stderr)
    raise
else:
    if not os.environ.get('E2E_OUT'):
        shutil.rmtree(OUT, ignore_errors=True)
