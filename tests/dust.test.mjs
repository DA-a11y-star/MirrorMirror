import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';

async function load(name, imports = {}) {
  const path = new URL(`../web/${name}.js`, import.meta.url);
  const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
  let source = (await readFile(path, 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  for (const [file, url] of Object.entries(imports)) source = source.replaceAll(`from './${file}.js'`, `from '${url}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
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
