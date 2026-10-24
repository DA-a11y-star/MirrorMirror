import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../web/vendor/three.module.js';

// Node doesn't consume the browser import map; resolve the same vendored module for these headless tests.
const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
const source = (await readFile(new URL('../web/offaxis.js', import.meta.url), 'utf8')).replaceAll("from 'three'", `from '${three}'`);
const { OffAxis, eyeOffset, offAxisProjection, validHead } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function baseCamera() {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
  camera.position.set(0, 1, 4);
  camera.lookAt(0, 0.4, 0);
  camera.updateMatrixWorld();
  return camera;
}

// A view camera as the off-axis class builds it, so projections can be compared in NDC.
function ndc(view, point) {
  view.updateMatrixWorld();
  return new THREE.Vector3(...point).project(view);
}

const head = (x, y, z) => ({ pos: [x, y, z], quat: [0, 0, 0, 1] });
// Runs frames at 60 fps; `reading` is re-sent every frame like a live tracker would (null = tracker silent).
const settle = (offAxis, steps = 200, t0 = 0, reading = offAxis.head && head(...offAxis.head)) => {
  let t = t0;
  for (let i = 0; i < steps; i++) { t += 16; if (reading) offAxis.setHead(reading, t); offAxis.update(0.016, t, 4.2); }
  return t;
};

test('validHead accepts a sane head and rejects junk', () => {
  assert.equal(validHead(head(0, 0, 0.6)), true);
  for (const bad of [null, undefined, {}, { pos: [0, 0] }, head(NaN, 0, 0.6), head(0, 0, 0.05), head(0, 0, 5), { pos: 'x' }]) {
    assert.equal(validHead(bad), false);
  }
});

test('eye offset: looking from the right moves the eye right, up moves it up, closer shrinks the eye-to-window gap', () => {
  const out = new THREE.Vector3();
  eyeOffset([0.1, 0, 0], 1, out);
  assert.ok(out.x > 0);
  eyeOffset([0, -0.1, 0], 1, out); // tracker y is down, so negative is up
  assert.ok(out.y > 0);
  eyeOffset([0, 0, -0.1], 1, out); // smaller distance = nearer the window, so the eye-to-window gap shrinks
  assert.ok(out.z < 0);
});

test('eye offset is clamped so a wild reading cannot fling the view', () => {
  const out = new THREE.Vector3();
  eyeOffset([5, 5, 5], 1, out);
  assert.ok(Math.abs(out.x) <= 0.35 && Math.abs(out.y) <= 0.35 && Math.abs(out.z) <= 0.5);
  const a = out.clone();
  eyeOffset([50, 50, 50], 1, out);
  near(out.x, a.x); near(out.y, a.y);
});

test('with the eye on-axis, the off-axis projection equals the ordinary perspective', () => {
  const cam = baseCamera();
  const focus = 4.2;
  const halfH = focus * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
  const m = new THREE.Matrix4();
  offAxisProjection(m, halfH * cam.aspect, halfH, focus, new THREE.Vector3(), cam.far);
  const ordinary = new THREE.PerspectiveCamera(cam.fov, cam.aspect, 0.05, cam.far).projectionMatrix;
  for (const p of [[0, 0, -3], [1, .5, -6], [-2, 1, -10]]) {
    const a = new THREE.Vector3(...p).applyMatrix4(m), b = new THREE.Vector3(...p).applyMatrix4(ordinary);
    near(a.x, b.x, 1e-4); near(a.y, b.y, 1e-4);
  }
});

test('a head at the neutral spot leaves the view exactly where the base camera is', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  o.setHead(head(0, 0, 0.55), 0);
  settle(o);
  near(o.view.position.distanceTo(cam.position), 0, 1e-4);
});

test('moving the head right slides near objects left and far objects right, and the focus plane stays put', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  const forward = new THREE.Vector3(); cam.getWorldDirection(forward);
  const at = d => cam.position.clone().addScaledVector(forward, d).toArray();
  o.setHead(head(0, 0, 0.55), 0);
  let t = settle(o, 50);
  const before = { near: ndc(o.view, at(2)).x, focus: ndc(o.view, at(4.2)).x, far: ndc(o.view, at(9)).x };

  settle(o, 200, t, head(0.15, 0, 0.55));
  const after = { near: ndc(o.view, at(2)).x, focus: ndc(o.view, at(4.2)).x, far: ndc(o.view, at(9)).x };

  assert.ok(after.near < before.near - 0.01, 'near moves left');
  assert.ok(after.far > before.far + 0.01, 'far moves right');
  near(after.focus, before.focus, 1e-3);
});

test('the eye moves along the base camera axes, even when the base camera is turned', () => {
  const cam = baseCamera();
  cam.position.set(4, 1, 0);
  cam.lookAt(0, 0.4, 0);
  cam.updateMatrixWorld();
  const o = new OffAxis(cam);
  o.setHead(head(0, 0, 0.55), 0);
  let t = settle(o, 50);
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  settle(o, 200, t, head(0.15, 0, 0.55));
  const moved = o.view.position.clone().sub(cam.position);
  assert.ok(moved.length() > 0.01);
  assert.ok(moved.normalize().dot(right) > 0.99);
});

test('losing the head eases the view back to the base camera instead of snapping or freezing', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  o.setHead(head(0.15, 0, 0.55), 0);
  o.neutral = [0, 0, 0.55];
  let t = settle(o, 100, 0, head(0.15, 0, 0.55));
  const displaced = o.view.position.distanceTo(cam.position);
  assert.ok(displaced > 0.01);
  t = settle(o, 20, t, null); // tracker silent but still inside the grace period: held where it was
  near(o.view.position.distanceTo(cam.position), displaced, displaced * 0.25);
  settle(o, 600, t, null);
  near(o.view.position.distanceTo(cam.position), 0, 1e-3);
});

test('recenter makes the current head position the new neutral', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  o.setHead(head(0, 0, 0.55), 0);
  let t = settle(o, 5, 0, head(0, 0, 0.55));
  t = settle(o, 100, t, head(0.2, 0, 0.7));
  assert.ok(o.view.position.distanceTo(cam.position) > 0.01);
  o.recenter();
  settle(o, 200, t, head(0.2, 0, 0.7));
  near(o.view.position.distanceTo(cam.position), 0, 1e-3);
});

test('strength 0 disables the effect', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam, 0);
  o.setHead(head(0.3, 0.1, 0.4), 0);
  settle(o, 200, 0, head(0.3, 0.1, 0.4));
  near(o.view.position.distanceTo(cam.position), 0, 1e-6);
});

test('the view follows the base camera as it orbits', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  settle(o, 5);
  cam.position.set(-3, 2, 3); cam.lookAt(0, 0.4, 0); cam.updateMatrixWorld();
  settle(o, 5);
  near(o.view.position.distanceTo(cam.position), 0, 1e-4);
  near(o.view.quaternion.angleTo(cam.quaternion), 0, 1e-4);
});

test('looking toward the right edge leans the viewpoint right; losing gaze eases back', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  let t = 0;
  for (let i = 0; i < 200; i++) { t += 16; o.setGaze({ x: 1, y: 0.5 }, t); o.update(0.016, t, 4.2); }
  const moved = o.view.position.clone().sub(cam.position);
  assert.ok(moved.length() > 0.01);
  assert.ok(moved.normalize().dot(right) > 0.99);
  for (let i = 0; i < 600; i++) { t += 16; o.update(0.016, t, 4.2); }
  near(o.view.position.distanceTo(cam.position), 0, 1e-3);
});

test('malformed gaze is ignored', () => {
  const o = new OffAxis(baseCamera());
  o.setGaze({ x: NaN, y: 0 }, 0);
  o.setGaze(null, 0);
  assert.equal(o.gazeTarget, null);
});

test('leaning toward the screen brings objects closer, never farther', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  const forward = new THREE.Vector3(); cam.getWorldDirection(forward);
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const point = d => cam.position.clone().addScaledVector(forward, d).addScaledVector(right, 0.5).toArray();
  o.setHead(head(0, 0, 0.55), 0);
  let t = settle(o, 50);
  const offset = d => ndc(o.view, point(d)).x;
  const before = [2, 4.2, 9].map(offset);
  for (const z of [0.5, 0.45, 0.4, 0.3]) {
    t = settle(o, 200, t, head(0, 0, z));
    const now = [2, 4.2, 9].map(offset);
    now.forEach((x, i) => assert.ok(x > before[i], `at ${z} m an object ${[2, 4.2, 9][i]} m away got farther`));
    before.splice(0, 3, ...now);
  }
  t = settle(o, 200, t, head(0, 0, 0.8)); // leaning back pushes things away again
  assert.ok([2, 4.2, 9].map(offset).every((x, i) => x < before[i]));
});

test('how much the view changes per centimeter of leaning stays steady as you lean closer', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  const forward = new THREE.Vector3(); cam.getWorldDirection(forward);
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const p = cam.position.clone().addScaledVector(forward, 6).addScaledVector(right, 1).toArray();
  o.setHead(head(0, 0, 0.55), 0);
  let t = settle(o, 50);
  const steps = [];
  let last = ndc(o.view, p).x;
  for (const z of [0.5, 0.45, 0.4, 0.35]) { // 5 cm each
    t = settle(o, 100, t, head(0, 0, z));
    const x = ndc(o.view, p).x;
    steps.push(x - last);
    last = x;
  }
  assert.ok(steps.every(s => s > 0));
  assert.ok(steps[3] / steps[0] < 2.2, `last step ${steps[3]} vs first ${steps[0]}`);
});

test('the leaning distance is capped so the eye cannot reach the window plane', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  o.setHead(head(0, 0, 0.9), 0);
  o.neutral = [0, 0, 0.9];
  settle(o, 300, 0, head(0, 0, 0.2));
  assert.ok(o.eye.z >= -o.focus * 0.6 - 1e-9);
});

test('sitting closer for a long time slowly becomes the new centered depth', () => {
  const cam = baseCamera();
  const o = new OffAxis(cam);
  o.setHead(head(0, 0, 0.55), 0);
  let t = settle(o, 50);
  t = settle(o, 100, t, head(0, 0, 0.45));
  const leaning = o.eye.z;
  assert.ok(leaning < -0.3);
  t = settle(o, 60 * 150, t, head(0, 0, 0.45)); // 150 s at 60 fps
  assert.ok(Math.abs(o.eye.z) < Math.abs(leaning) * 0.2, `eye.z still ${o.eye.z}`);
  t = settle(o, 100, t, head(0.1, 0, 0.45));
  assert.ok(o.eye.x > 0.2, 'sideways reference does not drift');
});
