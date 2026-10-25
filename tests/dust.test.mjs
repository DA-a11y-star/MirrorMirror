import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { load } from './load.mjs';

const { DustCloud } = await load('dust');
const protocolUrl = new URL('../web/object-protocol.js', import.meta.url).href;
const { Objects } = await load('objects', { 'object-protocol': protocolUrl });

const run = (dust, seconds) => { for (let t = 0; t < seconds; t += 1 / 60) dust.update(1 / 60); };

test('dust cloud: swirls while building, bursts and clears, never produces NaN', () => {
  const dust = new DustCloud(new THREE.Scene());
  assert.equal(dust.points.visible, false);
  dust.start(new THREE.Vector3(1, 0.25, -2));
  assert.equal(dust.state, 'building');
  assert.equal(dust.points.visible, true);
  run(dust, 1);
  assert.ok(dust.level > 0.99, 'fully faded in');
  const alphas = dust.alphas;
  assert.ok(alphas.every(a => Number.isFinite(a) && a > 0 && a < 1));
  assert.ok(dust.positions.every(Number.isFinite));
  dust.burst(new THREE.Vector3(1, 0.2, -2), 0.5);
  assert.equal(dust.state, 'burst');
  run(dust, 0.4);
  assert.ok(dust.positions.every(Number.isFinite) && dust.sizes.every(Number.isFinite));
  run(dust, 1.2);
  assert.equal(dust.state, 'idle');
  assert.equal(dust.points.visible, false, 'hidden once the burst is over');
});

test('dust cloud: stop thins it away without a burst, and start twice does not restart it', () => {
  const dust = new DustCloud(new THREE.Scene());
  dust.start(new THREE.Vector3());
  run(dust, 0.3);
  const t = dust.t;
  dust.start(new THREE.Vector3(0.1, 0, 0));
  assert.equal(dust.t, t, 'a second start keeps the cloud going');
  dust.stop();
  assert.equal(dust.state, 'fading');
  run(dust, 1);
  assert.equal(dust.state, 'idle');
  assert.equal(dust.active, false);
});

test('Objects.nextSpot skips occupied spots', () => {
  const container = new THREE.Group();
  const objects = new Objects(container, { register() {}, unregister() {} });
  const first = objects.nextSpot();
  assert.ok(Math.abs(first.x) < 1e-9 && Math.abs(first.z + 0.4) < 1e-9, 'the centre when the workspace is empty');
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
  block.position.set(0, 0.25, -0.4);
  container.add(block);
  const next = objects.nextSpot();
  assert.ok(Math.hypot(next.x - first.x, next.z - first.z) > 0.4, 'moves off an occupied centre');
});

test('dust cloud: cubes are pulled in from the air toward the core, then dive in on burst and vanish', () => {
  const dust = new DustCloud(new THREE.Scene());
  const core = new THREE.Vector3(2, 1, -3);
  assert.equal(dust.cubes.visible, false);
  dust.start(core);
  assert.equal(dust.cubes.visible, true);
  run(dust, 2);
  const e = dust.cubes.instanceMatrix.array;
  let outside = 0;
  for (let i = 0; i < dust.cubes.count; i++) {
    const o = i * 16;
    const size = Math.hypot(e[o], e[o + 1], e[o + 2]); // column length = scale (decompose is degenerate at size 0)
    const [x, y, z] = [e[o + 12], e[o + 13], e[o + 14]];
    assert.ok([x, y, z, size].every(Number.isFinite));
    assert.ok(y >= 0.05 - 1e-9, 'never below the floor');
    assert.ok(size <= 0.105 + 1e-9, `cubes stay small: ${size}`);
    if (Math.hypot(x - core.x, y - core.y, z - core.z) > 0.3) outside++;
  }
  assert.ok(outside > 10, `most cubes are still out in the air (${outside})`);
  const before = dust.cubeData.map(c => c.u);
  run(dust, 0.2);
  assert.ok(dust.cubeData.some((c, i) => c.u > before[i] || c.u < 0.05), 'cubes keep moving inward (or respawn at the edge)');
  dust.burst(new THREE.Vector3(0, 0.2, 0), 0.5);
  assert.equal(dust.rush, true);
  run(dust, 0.6);
  assert.equal(dust.cubes.visible, false, 'every cube has dived in and gone');
});

test('dust cloud: stopping fades the cubes away too', () => {
  const dust = new DustCloud(new THREE.Scene());
  dust.start(new THREE.Vector3(0, 1, -2));
  run(dust, 0.5);
  dust.stop();
  run(dust, 1);
  assert.equal(dust.cubes.visible, false);
  assert.equal(dust.state, 'idle');
});
