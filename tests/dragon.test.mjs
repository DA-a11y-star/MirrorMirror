import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { load } from './load.mjs';

const { Dragon, DRAGON_DEFAULTS, dragonPose, makePath, pointAt, radiusAt } = await load('dragon');
// The Chinese City's settings, so the test checks what ships (roofs there reach 9.2 m).
const CITY = { center: [0, 0], radius: [22, 34], height: [13, 19], speed: 8 };
const ROOF = 9.2;
const times = Array.from({ length: 40 }, (_, i) => i * 1.37);

test('the flight path is a closed loop that keeps to its radius and height range', () => {
  const path = makePath(CITY);
  assert.ok(pointAt(path, 0).distanceTo(pointAt(path, path.length)) < 1e-6, 'the end meets the start');
  const p = new THREE.Vector3();
  for (let s = 0; s < path.length; s += 1.7) {
    pointAt(path, s, p);
    const r = Math.hypot(p.x, p.z);
    assert.ok(r > 21 && r < 35, `radius ${r}`);
    assert.ok(p.y > 12.9 && p.y < 19.1, `height ${p.y}`);
  }
});

test('the body keeps its spacing at every moment, so it never stretches or bunches up', () => {
  const path = makePath(CITY);
  const spacing = path.cfg.spacing;
  for (const t of times) {
    const pose = dragonPose(path, t);
    for (let i = 1; i < pose.length; i++) {
      const d = pose[i].distanceTo(pose[i - 1]);
      assert.ok(Math.abs(d - spacing) < spacing * 0.03, `segment ${i} is ${d.toFixed(2)} m behind the one ahead at t=${t}`);
    }
  }
});

test('it flies above the rooftops everywhere, including the lowest dips of the wave', () => {
  const path = makePath(CITY);
  let lowest = Infinity;
  for (const t of times) for (const [i, p] of dragonPose(path, t).entries()) lowest = Math.min(lowest, p.y - radiusAt(i, path.cfg.segments));
  assert.ok(lowest > ROOF, `the underside reaches ${lowest.toFixed(2)} m, roofs are ${ROOF} m`);
});

test('the head leads: it moves toward where it faces, and the wave swells through the body rather than the head', () => {
  const path = makePath(CITY);
  const a = dragonPose(path, 5), b = dragonPose(path, 5.05);
  const travel = b[0].clone().sub(a[0]);
  const facing = a[0].clone().sub(a[1]);
  assert.ok(travel.normalize().dot(facing.normalize()) > 0.9, 'it flies head first');
  // How far each segment is pushed off the bare flight path by the wave.
  const bare = makePath({ ...CITY, wave: { side: 0, up: 0, length: 9, speed: 2.4 } });
  const wavy = dragonPose(path, 7), flat = dragonPose(bare, 7);
  const off = i => wavy[i].distanceTo(flat[i]);
  const peak = Math.max(...wavy.map((_, i) => off(i)));
  assert.ok(off(0) < peak * 0.55, `the head is calm (${off(0).toFixed(2)} of ${peak.toFixed(2)})`);
  assert.ok(peak > 0.6, 'the body really undulates');
});

test('the pose is a pure function of the clock, so two laptops agree and nothing is synced', () => {
  const one = dragonPose(makePath(CITY), 123.4), two = dragonPose(makePath({ ...CITY }), 123.4);
  one.forEach((p, i) => assert.ok(p.distanceTo(two[i]) < 1e-12));
  const later = dragonPose(makePath(CITY), 124.4);
  assert.ok(one[0].distanceTo(later[0]) > 4, 'and it keeps moving');
});

test('the built dragon has finite transforms at any time and a small draw-call budget; dispose removes it', () => {
  const scene = new THREE.Scene();
  const dragon = new Dragon(scene, CITY);
  let meshes = 0;
  dragon.root.traverse(node => { if (node.isMesh) meshes++; });
  assert.ok(meshes < 40, `${meshes} draw calls`);
  assert.equal(scene.children.includes(dragon.root), true);
  for (const t of [0, 0.01, 1, 33.3, 1e5, Date.now() / 1000]) {
    dragon.update(t);
    for (const mesh of [dragon.body, dragon.spines]) assert.ok(mesh.instanceMatrix.array.every(Number.isFinite), `instances at t=${t}`);
    dragon.root.updateMatrixWorld(true);
    dragon.root.traverse(node => assert.ok(node.matrixWorld.elements.every(Number.isFinite), `${node.type} at t=${t}`));
  }
  dragon.dispose();
  assert.equal(scene.children.includes(dragon.root), false);
});

test('thickness tapers from a thick body to a thin tail and defaults are sane', () => {
  const n = DRAGON_DEFAULTS.segments;
  assert.ok(radiusAt(0, n) < radiusAt(Math.floor(n * 0.15), n), 'a thin neck behind the head');
  assert.ok(radiusAt(n - 1, n) < radiusAt(Math.floor(n * 0.15), n) * 0.3, 'a thin tail');
  assert.ok(DRAGON_DEFAULTS.radius[0] < DRAGON_DEFAULTS.radius[1] && DRAGON_DEFAULTS.height[0] < DRAGON_DEFAULTS.height[1]);
});
