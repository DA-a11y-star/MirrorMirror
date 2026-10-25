"""Render both demo cities, exercise presentation/reduced motion and race preview loading against Play.

Run: python tests/e2e/visual.py. Screenshots and observations are kept in E2E_OUT (or a temporary directory).
Uses real vendored assets and Chrome's software GL; draw counts are useful, FPS is not a laptop benchmark.
"""
import asyncio
import functools
import json
import threading

from run import CHROME, OUT, ROOT, Page, Quiet, TestServer


async def key(page, code, key_value):
    await page.call('Page.bringToFront')
    await page.call('Input.dispatchKeyEvent', dict(type='keyDown', code=code, key=key_value))
    await page.call('Input.dispatchKeyEvent', dict(type='keyUp', code=code, key=key_value))
    await page.wait('app.input.pressed.size === 0', what=f'{code} is consumed by a render frame')


async def inspect(page):
    await page.js('app.propsReady.then(() => true)')
    await asyncio.sleep(.5)
    info = await page.js('''(() => {
      const meshes = []; app.scene.traverse(n => { if (n.isMesh || n.isPoints || n.isLine) meshes.push(n); });
      return {stats: app.props?.stats, calls: app.renderer.info.render.calls,
        triangles: app.renderer.info.render.triangles,
        environment: {fog: app.scene.fog.color.getHex(), sun: app.look.sun.color.getHex()},
        shaderFailures: app.renderer.info.programs.filter(p => p.diagnostics?.runnable === false).length,
        decorativeInBlocks: app.blocks.children.filter(n => n.userData.scenery).length};
    })()''')
    assert info['shaderFailures'] == 0 and info['decorativeInBlocks'] == 0, info
    assert not page.errors, page.errors
    assert not [e for e in page.console_errors if e['source'] == 'console'], page.console_errors
    return info


async def workspace(base, preset, reduced=False):
    name = preset + ('-reduced' if reduced else '')
    page = Page(name, base + f'?preset={preset}&tracker=mouse&demo=1')
    try:
        await page.start()
        await page.call('Emulation.setDeviceMetricsOverride', dict(width=1280, height=800, deviceScaleFactor=1, mobile=False))
        if reduced:
            await page.call('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'reduce'}]})
            await page.call('Page.reload')
        await page.wait('!!window.app?.props', seconds=90)
        info = await inspect(page)
        assert await page.js("document.body.classList.contains('presentation')")
        for selector in ['#workspace-debug', '#voice-tools', '#gesture-hud', '#gesture-settings', '#library-toggle']:
            assert await page.js(f"getComputedStyle(document.querySelector('{selector}')).display === 'none'"), selector
        await page.shot(name + '-spawn.png')
        if reduced:
            assert not any(info['stats'].get(k) for k in ['rain', 'petals', 'fireworks']), info
            clock = "JSON.stringify(app.props.group.children.map(n => [n.position.toArray(), n.rotation.toArray(), n.material?.uniforms?.uTime?.value]))"
            before = await page.js(clock)
            await asyncio.sleep(.5)
            assert await page.js(clock) == before, 'reduced-motion props must hold still'
        else:
            await key(page, 'KeyJ', 'j')
            await page.wait("!document.body.classList.contains('presentation')", what='J restores the controls')
            await page.js("document.getElementById('presentation-toggle').click()")
            assert await page.js("document.body.classList.contains('presentation')")
            # Presentation changes visibility only; keyboard movement, mode changes and the library still work.
            before = await page.js('app.locomotion.pos.toArray()')
            await page.call('Input.dispatchKeyEvent', dict(type='keyDown', code='KeyD', key='d'))
            await page.wait(f'app.locomotion.pos.x > {before[0] + .1}', what='movement in presentation mode')
            await page.call('Input.dispatchKeyEvent', dict(type='keyUp', code='KeyD', key='d'))
            await key(page, 'KeyR', 'r')
            if preset == 'chinese-city':
                assert info['stats']['lanternStrings'] > 0 and info['stats']['lanterns'] > 0
                assert await page.js('app.props.layout.lanternStrings.every(s => s.supported)')
                # Stand on the avenue facing an arch from ground level; keep its actual support geometry in view.
                await page.js('''(async () => {
                  const s = app.props.layout.lanternStrings[0], dx = s.b[0]-s.a[0], dz = s.b[2]-s.a[2], len = Math.hypot(dx,dz);
                  const nx=-dz/len, nz=dx/len;
                  app.renderer.setAnimationLoop(null);
                  const { PerspectiveCamera } = await import('three');
                  window.reviewCamera = new PerspectiveCamera(55,innerWidth/innerHeight,.05,140);
                  reviewCamera.position.set(s.x+nx*7,1.4,s.z+nz*7); reviewCamera.lookAt(s.x,2.8,s.z);
                  app.props.update(0,10,reviewCamera); app.renderer.render(app.scene,reviewCamera);
                })()''')
                await page.shot('chinese-city-arch-ground.png')
            # A high view checks the skyline, signage and airborne decorations beyond the spawn view.
            await page.js('app.locomotion.pos.y=24; app.locomotion.pitch=-0.25')
            await asyncio.sleep(.5)
            await page.shot(name + '-skyline.png')
        await inspect(page)
        return info
    finally:
        await page.close()


async def previews(base):
    page = Page('previews', base)
    try:
        await page.start()
        await page.call('Emulation.setDeviceMetricsOverride', dict(width=1280, height=800, deviceScaleFactor=1, mobile=False))
        await page.wait("document.querySelectorAll('.preset-card').length >= 7", seconds=90)
        await page.wait("['chinese-city','cyberpunk'].every(id => !document.querySelector(`[data-id=\"${id}\"] img`).hidden)", seconds=120)
        await page.shot('landing.png')
        # A second isolated panorama permits direct assertions about loading and disposal without product-only hooks.
        await page.js('''(async () => {
          const { Panorama } = await import('/panorama.js');
          const { loadRegistry } = await import('/presets.js');
          const { presets } = await loadRegistry();
          window.reviewPresets = presets; window.reviewPano = new Panorama(document.createElement('div'));
          await Promise.all(['chinese-city','cyberpunk'].map(id => reviewPano.modelFor(presets.find(p => p.id===id))));
          await Promise.all(['chinese-city','cyberpunk'].map(id => reviewPano.sceneFor(presets.find(p => p.id===id)).ready));
        })()''')
        assert await page.js("reviewPano.sceneFor(reviewPresets.find(p=>p.id==='chinese-city')).scene.getObjectByName('festival-arches') !== undefined")
        assert await page.js("reviewPano.sceneFor(reviewPresets.find(p=>p.id==='cyberpunk')).scene.getObjectByName('wet-street') !== undefined")
        # Destroy immediately after initiating both model and thumbnail loading; late work must stay disposed.
        await page.js('''(async () => {
          reviewPano.destroy();
          const { Panorama } = await import('/panorama.js');
          window.racingPano = new Panorama(document.createElement('div'));
          const pending = racingPano.thumbnails(reviewPresets.filter(p=>['chinese-city','cyberpunk'].includes(p.id)));
          racingPano.show(reviewPresets.find(p=>p.id==='chinese-city'));
          racingPano.destroy(); await pending;
        })()''')
        assert await page.js('racingPano.built.size===0 && racingPano.models.size===0 && racingPano.modelRoots.size===0 && racingPano.raf===0')
        await page.js('''(() => {
          for (const id of ['chinese-city','cyberpunk','chinese-city','cyberpunk']) document.querySelector(`[data-id="${id}"]`).click();
          document.getElementById('play').click();
        })()''')
        await page.wait('!!window.app?.props', seconds=120)
        await inspect(page)
        assert await page.js("!document.getElementById('landing') && !document.querySelector('#landing-bg canvas')")
        return {'liveMirrors': True, 'loadingRace': 'passed', 'playAfterRapidSwitches': 'passed'}
    finally:
        await page.close()


async def main():
    if not CHROME:
        raise RuntimeError('Chrome is required; set CHROME to the browser path')
    server = TestServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT / 'web')))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    results = {}
    try:
        for preset in ['chinese-city', 'cyberpunk']:
            for reduced in [False, True]:
                name = preset + ('-reduced' if reduced else '')
                results[name] = await workspace(base, preset, reduced)
                print('PASS:', name, json.dumps(results[name]), flush=True)
        results['previews'] = await previews(base)
        print('PASS: previews, quick switching, loading races and Play', flush=True)
    finally:
        (OUT / 'visual-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
        server.shutdown()
        print(f'Visual artifacts: {OUT}', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
