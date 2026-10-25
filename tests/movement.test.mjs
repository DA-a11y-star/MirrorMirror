import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { load } from './load.mjs';

const { Locomotion, FLY_SPEED, WORLD_BOUND, PITCH_LIMIT } = await load('locomotion');
const { CameraRig } = await load('camera');
const { Avatar, HAND_REACH, HAND_SIDE_M, HAND_REST_Y } = await load('avatar');

function intents(over = {}) {
  return {
    move: { forward: 0, strafe: 0, vertical: 0, ...over.move },
    turn: over.turn ?? 0,
    look: { dYaw: 0, dPitch: 0, ...over.look },
    zoom: over.zoom ?? 0,
    toggles: { ...over.toggles },
  };
}
function run(seconds, fps, step) {
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) step(dt);
}

test('walking accelerates smoothly toward walk speed and stops smoothly', () => {
  const l = new Locomotion();
  const speeds = [];
  run(1, 60, dt => { l.update(intents({ move: { forward: 1 } }), dt); speeds.push(l.vel.length()); });
  assert.ok(speeds[0] < FLY_SPEED * 0.3, 'does not jump to full speed');
  assert.ok(speeds.every((s, i) => i === 0 || s >= speeds[i - 1]), 'monotonic acceleration');
  assert.ok(Math.abs(l.vel.length() - FLY_SPEED) < 0.01);
  assert.ok(l.pos.z < 0, 'yaw 0 walks toward -z');
  run(1, 60, dt => l.update(intents(), dt));
  assert.ok(l.vel.length() < 0.01);
});

test('motion is frame-rate independent', () => {
  const at = fps => {
    const l = new Locomotion();
    run(2, fps, dt => l.update(intents({ move: { forward: 1, strafe: 0.5 }, turn: 0.3 }), dt));
    return l;
  };
  const a = at(60);
  const b = at(30);
  assert.ok(a.pos.distanceTo(b.pos) < 0.08, `positions differ by ${a.pos.distanceTo(b.pos)}`);
  assert.ok(Math.abs(a.yaw - b.yaw) < 0.03);
});

test('dt is clamped so a stall does not teleport the avatar', () => {
  const l = new Locomotion();
  l.vel.set(0, 0, -FLY_SPEED);
  l.update(intents({ move: { forward: 1 } }), 5);
  assert.ok(Math.abs(l.pos.z) <= FLY_SPEED * 0.05 + 1e-9);
});

test('diagonals are not faster and strafe goes right of facing', () => {
  const l = new Locomotion();
  run(2, 60, dt => l.update(intents({ move: { forward: 1, strafe: 1 } }), dt));
  assert.ok(l.vel.length() <= FLY_SPEED + 1e-6);
  assert.ok(l.vel.x > 0 && l.vel.z < 0);
  const turned = new Locomotion();
  turned.yaw = Math.PI / 2; // facing -x
  run(2, 60, dt => turned.update(intents({ move: { forward: 1 } }), dt));
  assert.ok(turned.vel.x < -1 && Math.abs(turned.vel.z) < 0.01);
});

test('turn input is smoothed and mouse look clamps pitch', () => {
  const l = new Locomotion();
  l.update(intents({ turn: 1 }), 1 / 60);
  assert.ok(l.yaw > 0 && l.turnVel < THREE.MathUtils.degToRad(120) * 0.3, 'eases into the turn');
  l.update(intents({ look: { dPitch: 10 } }), 1 / 60);
  assert.equal(l.pitch, PITCH_LIMIT);
  l.update(intents({ look: { dPitch: -20 } }), 1 / 60);
  assert.equal(l.pitch, -PITCH_LIMIT);
  const m = new Locomotion();
  m.update(intents({ look: { dYaw: 0.5 } }), 1 / 60);
  assert.ok(Math.abs(m.yaw - 0.5) < 1e-9, 'mouse yaw turns the avatar immediately');
});

test('flying is always on: vertical works, no gravity, and y cannot go below the floor', () => {
  const l = new Locomotion();
  assert.equal(l.flying, true);
  run(1, 60, dt => l.update(intents({ move: { vertical: 1 } }), dt));
  assert.ok(l.pos.y > 1.5);
  const hover = l.pos.y;
  run(1, 60, dt => l.update(intents(), dt));
  assert.ok(Math.abs(l.pos.y - hover) < 0.4, 'no gravity');
  run(1, 60, dt => l.update(intents({ move: { vertical: -1 } }), dt));
  assert.ok(l.vel.length() <= FLY_SPEED + 1e-6);
  const high = new Locomotion();
  high.pos.y = 0.2;
  run(1, 60, dt => high.update(intents({ move: { vertical: -1 } }), dt));
  assert.equal(high.pos.y, 0);
});

test('avatar stays inside the world bound; reset respawns at the origin', () => {
  const l = new Locomotion();
  l.pos.set(WORLD_BOUND - 0.05, 0, 0);
  run(2, 60, dt => l.update(intents({ move: { strafe: 1 } }), dt));
  assert.equal(l.pos.x, WORLD_BOUND);
  l.flying = true;
  l.pos.y = 3;
  l.update(intents({ toggles: { reset: true } }), 1 / 60);
  assert.ok(l.pos.length() < 0.01 && l.yaw === 0 && l.flying);
});

test('disabled locomotion (free cam) ignores every intent and coasts to rest', () => {
  const l = new Locomotion();
  run(1, 60, dt => l.update(intents({ move: { forward: 1 } }), dt));
  const before = l.pos.clone();
  run(2, 60, dt => l.update(intents({ move: { forward: 1 }, turn: 1, look: { dYaw: 1 }, toggles: { reset: true } }), dt, false));
  assert.equal(l.flying, true);
  assert.equal(l.yaw, 0);
  assert.ok(l.vel.length() < 0.01);
  assert.ok(l.pos.distanceTo(before) < FLY_SPEED * 0.4, 'only the remaining momentum');
});

function rigAt(l, camera = new THREE.PerspectiveCamera(55, 1.6, 0.05, 100), options = { firstPerson: false }) {
  const rig = new CameraRig(camera, options);
  const step = (over, dt = 1 / 60) => rig.update(intents(over), l.state(), 0, dt);
  return { rig, camera, step };
}

test('third person trails behind and above, with spring lag and a zoom range', () => {
  const l = new Locomotion();
  const { rig, camera, step } = rigAt(l);
  step();
  assert.ok(camera.position.z > 2 && camera.position.y > 1.3, 'behind (+z for yaw 0) and above');
  const forward = camera.getWorldDirection(new THREE.Vector3());
  assert.ok(forward.z < -0.5, 'looks toward the avatar and beyond');
  l.pos.set(3, 0, 0);
  step();
  const lagged = camera.position.x;
  assert.ok(lagged < 3 && lagged >= 0, 'lags behind a sudden move');
  for (let i = 0; i < 300; i++) step();
  assert.ok(Math.abs(camera.position.x - 3) < 0.05, 'catches up');
  for (let i = 0; i < 30; i++) step({ zoom: 10 });
  for (let i = 0; i < 200; i++) step();
  const far = camera.position.distanceTo(new THREE.Vector3(3, 1.3, 0));
  for (let i = 0; i < 30; i++) step({ zoom: -10 });
  for (let i = 0; i < 200; i++) step();
  const near = camera.position.distanceTo(new THREE.Vector3(3, 1.3, 0));
  assert.ok(far > near && near >= 1.4 && far <= 8.5, `${near} .. ${far}`);
  assert.ok(camera.position.y >= 0.2);
});

test('looking down never puts the third-person camera under the floor', () => {
  const l = new Locomotion();
  l.pitch = PITCH_LIMIT;
  const { camera, step } = rigAt(l);
  for (let i = 0; i < 120; i++) step();
  assert.ok(camera.position.y >= 0.2 - 1e-9);
  l.pitch = -PITCH_LIMIT;
  for (let i = 0; i < 120; i++) step();
  assert.ok(camera.position.y > 3, 'looking down orbits up high');
});

test('first person view eases over ~0.3 s to head height along the look direction', () => {
  const l = new Locomotion();
  l.yaw = 0.7;
  l.pitch = 0.2;
  const { rig, camera, step } = rigAt(l);
  for (let i = 0; i < 60; i++) step();
  step({ toggles: { view: true } });
  const early = camera.position.clone();
  assert.ok(Math.abs(early.y - 1.4) > 0.2 && !rig.hideAvatar, 'does not cut: still out at the third-person position');
  for (let i = 0; i < 12; i++) step(); // 0.2 s
  assert.ok(rig.fpWeight > 0.5 && rig.fpWeight < 1);
  for (let i = 0; i < 40; i++) step();
  assert.equal(rig.fpWeight, 1);
  assert.ok(rig.hideAvatar);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(0, 1.4, 0)) < 1e-6);
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const want = new THREE.Vector3(-Math.sin(0.7) * Math.cos(0.2), Math.sin(0.2), -Math.cos(0.7) * Math.cos(0.2));
  assert.ok(dir.distanceTo(want) < 1e-6);
  step({ toggles: { view: true } });
  assert.ok(rig.fpWeight < 1);
});

test('free cam: detaches, flies along its look direction, the avatar stays, exit eases back', () => {
  const l = new Locomotion();
  const { rig, camera, step } = rigAt(l);
  for (let i = 0; i < 120; i++) step();
  const start = camera.position.clone();
  step({ toggles: { freeCam: true } });
  assert.ok(rig.freeActive);
  assert.ok(camera.position.distanceTo(start) < 0.05, 'entering does not jump');
  for (let i = 0; i < 60; i++) step({ move: { forward: 1 } });
  const flown = camera.position.clone();
  assert.ok(flown.distanceTo(start) > 3, 'flew away');
  assert.ok(l.pos.length() === 0, 'free cam never moves the avatar');
  // turning the free camera does not turn the avatar (locomotion is disabled while free)
  l.update(intents({ turn: 1, look: { dYaw: 1 } }), 1 / 60, false);
  assert.equal(l.yaw, 0);
  step({ toggles: { freeCam: true } });
  assert.ok(!rig.freeActive && rig.freeBlend > 0.9);
  const samples = [];
  for (let i = 0; i < 12; i++) { step(); samples.push(camera.position.distanceTo(start)); }
  assert.ok(samples[0] > 1, 'starts from where the free camera was');
  assert.ok(samples.every((d, i) => i === 0 || d <= samples[i - 1] + 1e-9), 'eases back monotonically');
  for (let i = 0; i < 40; i++) step();
  assert.equal(rig.freeBlend, 0);
  assert.ok(camera.position.distanceTo(start) < 0.05);
});

test('free cam speed scales with scroll within 0.5x-4x, and R snaps it to the avatar camera', () => {
  const l = new Locomotion();
  const { rig, camera, step } = rigAt(l);
  for (let i = 0; i < 60; i++) step();
  step({ toggles: { freeCam: true } });
  for (let i = 0; i < 100; i++) step({ zoom: -5 });
  assert.equal(rig.free.scale, 4);
  for (let i = 0; i < 100; i++) step({ zoom: 5 });
  assert.equal(rig.free.scale, 0.5);
  for (let i = 0; i < 60; i++) step({ move: { forward: 1, vertical: 1 } });
  const away = camera.position.distanceTo(rig.avatarPos);
  assert.ok(away > 0.5);
  step({ toggles: { reset: true } });
  assert.ok(camera.position.distanceTo(rig.avatarPos) < 0.2);
  assert.equal(l.pos.length(), 0);
});

test('free cam stays in bounds and above the floor', () => {
  const l = new Locomotion();
  const { rig, camera, step } = rigAt(l);
  step();
  step({ toggles: { freeCam: true } });
  for (let i = 0; i < 1800; i++) step({ move: { forward: 1, vertical: -1 }, turn: 0 });
  assert.ok(Math.abs(rig.free.pos.x) <= 20 && Math.abs(rig.free.pos.z) <= 20 && rig.free.pos.y >= 0.2);
  assert.ok(camera.position.y >= 0.2 - 1e-9);
});

test('avatar animation: bob, lean into motion, body turns toward movement, head hides', () => {
  const scene = new THREE.Scene();
  const avatar = new Avatar(scene);
  const state = { pos: [0, 0, 0], vel: [0, 0, -2], yaw: 0, pitch: 0.3, flying: false };
  let maxBob = 0;
  for (let i = 0; i < 120; i++) { avatar.update(state, 1 / 60); maxBob = Math.max(maxBob, avatar.bob); }
  assert.ok(maxBob > 0.01 && maxBob <= 0.041);
  assert.ok(avatar.body.rotation.x < -0.1, 'leans forward');
  assert.ok(Math.abs(avatar.bodyYaw) < 0.05);
  assert.equal(avatar.head.rotation.x, 0.3);
  const strafing = { ...state, vel: [2, 0, 0] };
  for (let i = 0; i < 240; i++) avatar.update(strafing, 1 / 60);
  assert.ok(avatar.bodyYaw < -0.3 && avatar.bodyYaw > -1.2, `body turned toward moving right: ${avatar.bodyYaw}`);
  const back = { ...state, vel: [0, 0, 2] };
  for (let i = 0; i < 240; i++) avatar.update(back, 1 / 60);
  assert.ok(Math.abs(avatar.bodyYaw) < 0.2, 'walking backwards does not spin the body around');
  const idle = { ...state, vel: [0, 0, 0] };
  for (let i = 0; i < 240; i++) avatar.update(idle, 1 / 60);
  assert.ok(avatar.bob < 0.01 && Math.abs(avatar.body.rotation.x) < 0.01 && Math.abs(avatar.bodyYaw) < 0.01);
  const hover = { ...idle, flying: true, pos: [0, 2, 0] };
  const ys = [];
  for (let i = 0; i < 180; i++) { avatar.update(hover, 1 / 60); ys.push(avatar.root.position.y); }
  assert.ok(Math.max(...ys) - Math.min(...ys) < 1e-9, 'a still avatar does not bob, even while flying');
  avatar.setHeadVisible(false);
  assert.equal(avatar.head.visible, false);
});

// input.js is the only keyboard reader; exercise it against a fake DOM.
function fakeEvent(type, target) {
  const e = new Event(type);
  Object.defineProperty(e, 'target', { value: target });
  return e;
}
async function makeInput(options = {}) {
  class FakeElement extends EventTarget { requestPointerLock() { this.lockRequested = true; } closest() { return null; } }
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLButtonElement = class extends FakeElement {};
  globalThis.Element = FakeElement;
  const doc = new EventTarget();
  globalThis.document = doc;
  const { Input, emptyIntents, MOUSE_SENSITIVITY } = await load('input');
  const target = new EventTarget();
  const canvas = new FakeElement();
  const input = new Input(canvas, { target, ...options });
  const key = (type, code, extra = {}) => {
    const e = Object.assign(fakeEvent(type, canvas), { code, repeat: false, preventDefault() { this.prevented = true; } }, extra);
    target.dispatchEvent(e);
    return e;
  };
  return { input, key, target, doc, canvas, emptyIntents, MOUSE_SENSITIVITY };
}

test('input: keys become intents, toggles fire for one frame, taps shorter than a frame still count', async () => {
  const { input, key } = await makeInput();
  key('keydown', 'ArrowUp');
  key('keydown', 'KeyD');
  key('keydown', 'ArrowLeft');
  let i = input.poll();
  assert.deepEqual([i.move.forward, i.move.strafe, i.turn], [1, 1, 1]);
  key('keyup', 'ArrowUp');
  key('keyup', 'KeyD');
  key('keyup', 'ArrowLeft');
  i = input.poll();
  assert.deepEqual([i.move.forward, i.move.strafe, i.turn], [0, 0, 0]);
  key('keydown', 'ArrowDown');
  key('keyup', 'ArrowDown');
  assert.equal(input.poll().move.forward, -1, 'a tap is seen by the next poll');
  assert.equal(input.poll().move.forward, 0);

  key('keydown', 'Space');
  key('keydown', 'ShiftLeft');
  assert.equal(input.poll().move.vertical, 0, 'space and shift cancel');
  key('keyup', 'ShiftLeft');
  assert.equal(input.poll().move.vertical, 1);

  for (const [code, name] of [['KeyM', 'mode'], ['KeyV', 'view'], ['KeyC', 'freeCam'], ['Backquote', 'dev'], ['KeyP', 'depthFx'], ['KeyR', 'reset'], ['KeyH', 'recenter']]) {
    key('keydown', code);
    assert.equal(input.poll().toggles[name], true, name);
    assert.equal(input.poll().toggles[name], false, `${name} lasts one frame`);
  }
  key('keydown', 'KeyM');
  key('keydown', 'KeyM', { repeat: true });
  input.poll();
  assert.equal(input.poll().toggles.mode, false, 'auto-repeat does not retrigger');
});

test('input: prevents page scroll on arrows/space, ignores modified keys, clears on blur', async () => {
  const { input, key, target } = await makeInput();
  assert.ok(key('keydown', 'ArrowUp').prevented);
  assert.ok(key('keydown', 'Space').prevented);
  assert.ok(!key('keydown', 'KeyA').prevented);
  key('keydown', 'KeyR', { metaKey: true }); // Cmd+R must still reload the page
  assert.equal(input.poll().toggles.reset, false);
  key('keydown', 'ArrowUp');
  target.dispatchEvent(new Event('blur'));
  assert.equal(input.poll().move.forward, 0, 'held keys are cleared when the window loses focus');
});

test('input: mouse look only while pointer-locked; scroll becomes zoom', async () => {
  const { input, doc, canvas, target, MOUSE_SENSITIVITY } = await makeInput();
  const move = (dx, dy) => doc.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: dx, movementY: dy }));
  move(50, 50);
  assert.equal(input.poll().look.dYaw, 0, 'ignored without pointer lock');
  canvas.dispatchEvent(new Event('click'));
  assert.ok(canvas.lockRequested);
  globalThis.document.pointerLockElement = canvas;
  doc.dispatchEvent(new Event('pointerlockchange'));
  move(100, -40);
  const i = input.poll();
  assert.ok(Math.abs(i.look.dYaw + 100 * MOUSE_SENSITIVITY) < 1e-12, 'mouse right turns right (yaw decreases)');
  assert.ok(i.look.dPitch > 0, 'mouse up looks up');
  assert.equal(input.poll().look.dYaw, 0, 'deltas are consumed');
  target.dispatchEvent(Object.assign(fakeEvent('wheel', canvas), { deltaY: 200, deltaMode: 0, preventDefault() {} }));
  assert.equal(input.poll().zoom, 2);
});

test('input: with the mouse fallback the left click is a pinch, so only a right-click locks the pointer', async () => {
  const { canvas } = await makeInput({ mouseFallback: true });
  canvas.dispatchEvent(new Event('click'));
  assert.equal(canvas.lockRequested, undefined, 'a left click must not steal the cursor from the pinch');
  const menu = Object.assign(new Event('contextmenu'), { preventDefault() { this.prevented = true; } });
  canvas.dispatchEvent(menu);
  assert.ok(canvas.lockRequested);
  assert.ok(menu.prevented, 'no browser menu over the scene');
});

test('input: voice buttons retain focus and own recording keys and scrolling', async () => {
  const { input, target } = await makeInput();
  const microphone = new globalThis.HTMLButtonElement();
  microphone.closest = selector => selector.includes('#voice-tools') ? microphone : null;
  let blurred = false;
  microphone.blur = () => { blurred = true; };
  for (const code of ['Space', 'Enter', 'KeyF', 'KeyH', 'ArrowUp']) {
    target.dispatchEvent(Object.assign(fakeEvent('keydown', microphone), {
      code, repeat: false, preventDefault() { throw new Error('Game input must not consume voice keys'); },
    }));
    target.dispatchEvent(Object.assign(fakeEvent('keyup', microphone), {
      code, preventDefault() { throw new Error('Game input must not consume voice keyup'); },
    }));
  }
  target.dispatchEvent(Object.assign(fakeEvent('wheel', microphone), {
    deltaY: 200, deltaMode: 0, preventDefault() { throw new Error('Voice panel scrolling belongs to the panel'); },
  }));
  const intent = input.poll();
  assert.equal(blurred, false);
  assert.deepEqual(intent.move, { forward: 0, strafe: 0, vertical: 0 });
  assert.equal(intent.zoom, 0);
  assert.ok(Object.values(intent.toggles).every(value => !value));
});

test('your own avatar is hidden in first person (the default) and shown in third person and free cam', () => {
  const l = new Locomotion();
  const { rig, step } = rigAt(l, undefined, undefined);
  const fresh = new CameraRig(new THREE.PerspectiveCamera(55, 1.6, 0.05, 100));
  assert.equal(fresh.firstPerson, true, 'starts in first person');
  assert.equal(fresh.hideAvatar, true, 'so your avatar is hidden from the start');
  assert.equal(rig.hideAvatar, false, 'third person shows it');
  step({ toggles: { view: true } });
  for (let i = 0; i < 40; i++) step();
  assert.equal(rig.hideAvatar, true);
  step({ toggles: { freeCam: true } });
  assert.equal(rig.hideAvatar, false, 'free cam shows the avatar');
  step({ toggles: { freeCam: true } });
  for (let i = 0; i < 40; i++) step();
  assert.equal(rig.hideAvatar, true, 'back in first person it hides again');
  const scene = new THREE.Scene();
  const avatar = new Avatar(scene);
  avatar.setVisible(false);
  assert.equal(avatar.root.visible, false);
});

test('a custom spawn is used at start and on respawn', () => {
  const l = new Locomotion({ spawn: { pos: [0, 0, 3], pitch: -0.35 } });
  assert.deepEqual(l.pos.toArray(), [0, 0, 3]);
  assert.equal(l.pitch, -0.35);
  run(1, 60, dt => l.update(intents({ move: { forward: 1 }, look: { dPitch: 0.1 } }), dt));
  l.update(intents({ toggles: { reset: true } }), 1 / 60);
  assert.deepEqual(l.pos.toArray(), [0, 0, 3]);
  assert.equal(l.pitch, -0.35);
});

test('avatar walking: shoes plant on the floor, step while moving and gather at rest', () => {
  const scene = new THREE.Scene();
  const avatar = new Avatar(scene);
  const pos = [0, 0, 0];
  const worldShoe = i => ({ x: pos[0] + avatar.shoes[i].position.x, z: pos[2] + avatar.shoes[i].position.z, y: avatar.shoes[i].position.y });
  let lifted = 0;
  let planted = 0;
  let anchor = null;
  let prevPhase = 0;
  for (let i = 0; i < 400; i++) {
    pos[2] -= 2 / 60;
    avatar.update({ pos, vel: [0, 0, -2], yaw: 0, pitch: 0, flying: true }, 1 / 60);
    if (i < 120) continue; // let the lean and body yaw settle
    const w = worldShoe(0);
    const grounded = avatar.shoes[0].position.y - avatar.feet.position.y < 0.0605 + avatar.bob;
    if (w.y > 0.07 + 0.01) lifted++;
    if (w.y <= 0.0601) {
      planted++;
      if (anchor && avatar.phase >= prevPhase && Math.abs(w.z - anchor.z) > 0.12) assert.fail(`planted shoe slid: ${w.z - anchor.z}`);
      anchor ??= w;
    } else anchor = null;
    prevPhase = avatar.phase;
    assert.ok(Number.isFinite(w.x) && Number.isFinite(w.z) && grounded !== undefined);
  }
  assert.ok(lifted > 20 && planted > 20, `steps: lifted ${lifted}, planted ${planted}`);
  for (let i = 0; i < 120; i++) avatar.update({ pos, vel: [0, 0, 0], yaw: 0, pitch: 0, flying: true }, 1 / 60);
  const [a, b] = [avatar.shoes[0].position, avatar.shoes[1].position];
  assert.ok(Math.abs(a.z) < 0.01 && Math.abs(b.z) < 0.01, 'standing shoes sit side by side');
  assert.ok(Math.abs(a.x - b.x) > 0.15, 'and apart, but tucked under the belly');
  assert.ok(Math.abs(a.y - 0.06) < 1e-6, 'resting on the floor');
});

test('avatar walking: flying clear of the floor, shoes dangle instead of stepping', () => {
  const scene = new THREE.Scene();
  const avatar = new Avatar(scene);
  for (let i = 0; i < 120; i++) avatar.update({ pos: [0, 3, 0], vel: [0, 0, -2], yaw: 0, pitch: 0, flying: true }, 1 / 60);
  const ys = [];
  for (let i = 0; i < 120; i++) {
    avatar.update({ pos: [0, 3, 0], vel: [0, 0, -2], yaw: 0, pitch: 0, flying: true }, 1 / 60);
    ys.push(avatar.shoes[0].position.y, avatar.shoes[1].position.y);
  }
  assert.ok(Math.max(...ys) - Math.min(...ys) < 1e-6, 'no stepping in the air');
  assert.ok(avatar.bob < 1e-9, 'no step bob in the air');
});

test('floors: a raised floor lifts you smoothly, and you cannot sink through it', () => {
  const l = new Locomotion();
  l.floorAt = (x, z) => (Math.abs(x) < 2 && Math.abs(z) < 2 ? 0.3 : 0); // a 4 m deck, 0.3 m thick
  run(0.5, 60, dt => l.update(intents(), dt));
  assert.ok(Math.abs(l.pos.y - 0.3) < 1e-6, `standing on the deck at the origin: ${l.pos.y}`);
  run(1, 60, dt => l.update(intents({ move: { vertical: -1 } }), dt));
  assert.ok(l.pos.y >= 0.3 - 1e-9, 'pushing down cannot go through the deck');
  const l2 = new Locomotion();
  l2.floorAt = l.floorAt;
  l2.pos.set(-5, 0, 0);
  const ys = [];
  run(3, 60, dt => { l2.update(intents({ move: { strafe: 1 } }), dt); ys.push(l2.pos.y); });
  assert.ok(Math.max(...ys) > 0.29, 'walking onto the deck lifts you to it');
  assert.ok(ys.every((y, i) => i === 0 || Math.abs(y - ys[i - 1]) < 0.15), 'smoothly, no teleport');
  assert.ok(l2.pos.x > 2 && l2.pos.y < 0.3, `and once past it you are down at ground level again: ${l2.pos.y}`);
  const flat = new Locomotion();
  run(1, 60, dt => flat.update(intents({ move: { vertical: -1 } }), dt));
  assert.equal(flat.pos.y, 0, 'with no floor function the floor is still 0');
});

test('avatar standing on a raised floor is standing, not flying', () => {
  const avatar = new Avatar(new THREE.Scene());
  avatar.floorAt = () => 0.3;
  for (let i = 0; i < 120; i++) avatar.update({ pos: [0, 0.3, 0], vel: [0, 0, -2], yaw: 0, pitch: 0, flying: true }, 1 / 60);
  assert.ok(avatar.air < 0.01, `on the deck, not airborne (${avatar.air})`);
  const ys = [];
  for (let i = 0; i < 60; i++) { avatar.update({ pos: [0, 0.3, 0], vel: [0, 0, -2], yaw: 0, pitch: 0, flying: true }, 1 / 60); ys.push(avatar.shoes[0].position.y); }
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.05, 'the shoes step');
});

test('avatar hands: the balls follow where your hands are, rest at the sides, and ease back when tracking stops', () => {
  const avatar = new Avatar(new THREE.Scene());
  const state = { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0.7, pitch: 0, flying: true };
  const hand = (side, x, y, z) => ({ side, lm: Array.from({ length: 21 }, (_, i) => [x + 0.01 * (i % 3), y, z]) });
  for (let i = 0; i < 30; i++) avatar.update(state, 1 / 60);
  const [leftRest, rightRest] = avatar.gloves.map(g => g.position.clone());
  assert.ok(leftRest.x < 0 && rightRest.x > 0, 'resting: one ball hangs at each side');
  assert.equal(avatar.handsGroup.rotation.y, 0.7, 'hands live in the view frame, so they turn with where you look');
  // The right hand raised 25 cm above the usual spot and pushed toward the screen.
  avatar.setHands([hand('right', 0.1, -0.15, 0.3)]);
  for (let i = 0; i < 60; i++) { avatar.setHands([hand('right', 0.1, -0.15, 0.3)]); avatar.update(state, 1 / 60); }
  const raised = avatar.gloves[1].position;
  assert.ok(raised.y > rightRest.y + 0.1, `lifted with the hand (${raised.y} vs ${rightRest.y})`);
  assert.ok(raised.z < rightRest.z - 0.05, 'and reaching forward (-z)');
  assert.ok(avatar.gloves[0].position.distanceTo(leftRest) < 1e-6, 'the untracked left ball stays at rest');
  // A hand far away stops at the reach from the belly.
  for (let i = 0; i < 90; i++) { avatar.setHands([hand('left', -0.9, -0.9, -0.2)]); avatar.update(state, 1 / 60); }
  const far = avatar.gloves[0].position;
  assert.ok(Math.hypot(far.x + HAND_SIDE_M * 0.5, far.y - HAND_REST_Y, far.z) <= HAND_REACH + 1e-3, 'within reach of the belly');
  // No frames for a second: both come back to rest.
  for (let i = 0; i < 120; i++) avatar.update(state, 1 / 60);
  assert.ok(avatar.gloves[1].position.distanceTo(rightRest) < 0.01 && avatar.gloves[0].position.distanceTo(leftRest) < 0.01);
  // Broken landmarks are ignored.
  avatar.setHands([{ side: 'right', lm: [[NaN, 0, 0]] }, { side: 'up', lm: [] }, null, 4]);
  avatar.setHands('nonsense');
  avatar.update(state, 1 / 60);
  assert.ok(avatar.gloves.every(g => Number.isFinite(g.position.x + g.position.y + g.position.z)));
});

test('avatar hands go back to their resting spots when told to (`rest`), and follow the hand otherwise', () => {
  const avatar = new Avatar(new THREE.Scene());
  const state = { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, flying: true };
  const palm = (x, y, z) => Array.from({ length: 21 }, (_, i) => [x + 0.005 * (i % 4), y, z]);
  const settle = hands => { for (let i = 0; i < 90; i++) { avatar.setHands(hands); avatar.update(state, 1 / 60); } return avatar.gloves[1].position.clone(); };
  const rest = avatar.gloves[1].userData.rest;
  const following = settle([{ side: 'right', lm: palm(0.1, -0.1, 0.3) }]);
  assert.ok(following.distanceTo(rest) > 0.1, 'tracked: the ball follows the hand away from rest');
  const clutched = settle([{ side: 'right', lm: palm(0.1, -0.1, 0.3), rest: true }]);
  assert.ok(clutched.distanceTo(rest) < 1e-3, 'rest: the ball returns to the resting spot even though the hand is still tracked');
  const again = settle([{ side: 'right', lm: palm(0.1, -0.1, 0.3), rest: false }]);
  assert.ok(again.distanceTo(following) < 1e-3, 'and follows the hand again when the flag clears');
  assert.ok(avatar.gloves[0].position.distanceTo(avatar.gloves[0].userData.rest) < 1e-6, 'the other hand is untouched');
});

test('avatar head: follows the view exactly, adds the real head\'s turn on top, eases into it and settles back', () => {
  const avatar = new Avatar(new THREE.Scene());
  const state = { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0.5, pitch: 0.2, flying: true };
  const view = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.5, 0, 'YXZ'));
  const run = (frames, dt = 1 / 60) => { for (let i = 0; i < frames; i++) avatar.update(state, dt); };
  run(30);
  assert.equal(avatar.head.rotation.y, 0.5);
  assert.equal(avatar.head.rotation.x, 0.2, 'with no head data it is exactly the view');

  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
  avatar.setHeadTurn(turn);
  run(2);
  const early = avatar.head.quaternion.angleTo(view);
  assert.ok(early > 0.01 && early < 0.55, `it eases in rather than snapping (${early})`);
  run(120);
  const want = view.clone().multiply(turn);
  assert.ok(avatar.head.quaternion.angleTo(want) < 0.01, 'it ends on the view turned by the real head');
  assert.ok(Math.abs(avatar.head.quaternion.angleTo(view) - 0.6) < 0.01, 'by the amount the real head turned');

  avatar.setHeadTurn(null);
  run(240);
  assert.ok(avatar.head.quaternion.angleTo(view) < 0.001, 'with the head data gone it settles back to the view');
  assert.equal(avatar.head.rotation.y, 0.5, 'and is exactly the view again');
});
