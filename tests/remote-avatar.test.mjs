import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';

// Node doesn't consume the browser import map; resolve the same vendored module for these headless tests.
async function load(name) {
  const path = new URL(`../web/${name}.js`, import.meta.url);
  const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
  const source = (await readFile(path, 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const { RemoteAvatar, headQuaternion } = await load('remote-avatar');
const { Avatar, EYE_HEIGHT } = await load('avatar');

// Stands in for the Hands instance reserved for the peer.
class FakeHands {
  constructor() { this.frame = null; this.camera = null; }
  setFrame(frame) { this.frame = frame; }
  update(dt, camera) { this.camera = camera; }
}
const snapshot = (extra = {}) => ({ pos: [0, 0, -3], vel: [0, 0, 0], yaw: Math.PI, pitch: 0, flying: false, ...extra });
const message = (avatar = snapshot(), extra = {}) => ({
  avatar, head: { quat: [0, 0, 0, 1] }, target: 'b1', hands: [{ side: 'right', pinch: .5, lm: [] }], ...extra,
});

function setup() {
  const scene = new THREE.Scene();
  const hands = new FakeHands();
  const body = new Avatar(scene);
  const avatar = new RemoteAvatar('B', body, hands, EYE_HEIGHT);
  return { scene, hands, body, avatar };
}
const forward = q => new THREE.Vector3(0, 0, -1).applyQuaternion(q);

test('a frontal head is the identity and turning toward the user\'s right turns the head toward their right', () => {
  const frontal = headQuaternion([0, 0, 0, 1]);
  assert.ok(forward(frontal).distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9);
  // The tracker reports yaw to the user's right as a negative rotation about its (downward) y axis.
  const right = headQuaternion([0, -Math.sin(.25), 0, Math.cos(.25)]);
  assert.ok(forward(right).x > .3 && Math.abs(forward(right).y) < 1e-9, 'nose toward +x, the user\'s right');
  // Looking up is a negative rotation about the tracker's x axis.
  const up = headQuaternion([-Math.sin(.2), 0, 0, Math.cos(.2)]);
  assert.ok(forward(up).y > .15 && Math.abs(forward(up).x) < 1e-9, 'nose up');
  assert.ok(Math.abs(right.length() - 1) < 1e-9);
});

test('nothing is drawn until the other user has sent something', () => {
  const s = setup();
  assert.equal(s.body.root.visible, false);
  s.avatar.update(1 / 60, 10);
  assert.equal(s.body.root.visible, false);
  assert.equal(s.avatar.live, false);
});

test('their walking body stands where they stand, and their landmarks are drawn from their eyes', () => {
  const s = setup();
  s.avatar.setState(message(), 0);
  s.avatar.update(1 / 60, 10);
  assert.equal(s.avatar.live, true);
  assert.equal(s.body.root.visible, true);
  assert.deepEqual(s.body.root.position.toArray(), [0, 0, -3]);
  assert.ok(Math.abs(s.avatar.seat.position.y - EYE_HEIGHT) < 1e-9);
  assert.deepEqual(s.hands.frame, message().hands);
  assert.equal(s.hands.camera, s.avatar.seat, 'remote landmarks are placed relative to the remote user\'s own view');
  assert.equal(s.avatar.looking, 'b1');
});

test('their body faces the way they face, and their own head turn adds to it', () => {
  const s = setup();
  s.avatar.setState(message(snapshot({ yaw: Math.PI, pitch: 0 })), 0);
  s.avatar.update(1 / 60, 10);
  assert.ok(forward(s.body.head.quaternion).distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-9, 'yaw pi faces +z, toward the other user');

  const turned = setup();
  turned.avatar.setState(message(snapshot(), { head: { quat: [0, -Math.sin(.25), 0, Math.cos(.25)] } }), 0);
  turned.avatar.update(1 / 60, 10);
  const facing = forward(turned.body.head.quaternion);
  // Facing +z, turning to their right is toward world -x; the tracker's .25 half-angle is a .5 rad turn.
  assert.ok(Math.abs(facing.x + Math.sin(.5)) < 1e-9 && Math.abs(facing.z - Math.cos(.5)) < 1e-9, `got ${facing.toArray()}`);
});

test('a walking snapshot animates their body, not just moves it', () => {
  const s = setup();
  s.avatar.setState(message(snapshot({ yaw: 0, vel: [0, 0, -2] })), 0);
  for (let i = 0; i < 30; i++) s.avatar.update(1 / 60, 10 + i * 16);
  assert.ok(s.body.leanForward > .05, `leans into the motion, got ${s.body.leanForward}`);
});

test('a user who starts walking after standing still gets the lean and bob of walking', () => {
  const s = setup();
  s.avatar.setState(message(snapshot({ yaw: 0 })), 0);
  s.avatar.update(1 / 60, 10);
  assert.equal(s.body.leanForward, 0);
  s.avatar.setState(message(snapshot({ yaw: 0, vel: [0, 0, -2] })), 20);
  for (let i = 0; i < 40; i++) s.avatar.update(1 / 60, 30 + i * 16);
  assert.ok(s.body.leanForward > .05, `got ${s.body.leanForward}`);
});

test('moves ease toward the newest pose instead of jumping, and turns take the short way round', () => {
  const s = setup();
  s.avatar.setState(message(snapshot({ pos: [0, 0, -3] })), 0);
  s.avatar.update(1 / 60, 10);
  s.avatar.setState(message(snapshot({ pos: [2, 0, -3] })), 20);
  s.avatar.update(1 / 60, 30);
  assert.ok(s.body.root.position.x > 0 && s.body.root.position.x < 2);
  for (let i = 0; i < 60; i++) s.avatar.update(1 / 60, 40 + i * 16);
  assert.ok(Math.abs(s.body.root.position.x - 2) < .01);

  const t = setup();
  t.avatar.setState(message(snapshot({ yaw: 3.1 })), 0);
  t.avatar.update(1 / 60, 10);
  t.avatar.setState(message(snapshot({ yaw: -3.1 })), 20);
  t.avatar.update(1 / 60, 30);
  assert.ok(Math.abs(t.avatar.shown.yaw) > 3, `a .08 rad turn must not swing through 0, got ${t.avatar.shown.yaw}`);
});

test('a peer that goes quiet disappears with its hands, and reappears in place', () => {
  const s = setup();
  s.avatar.setState(message(), 0);
  s.avatar.update(1 / 60, 100);
  s.avatar.update(1 / 60, 900);
  assert.equal(s.avatar.live, false);
  assert.equal(s.body.root.visible, false);
  assert.deepEqual(s.hands.frame, []);
  assert.equal(s.avatar.looking, null);
  s.avatar.setState(message(snapshot({ pos: [4, 0, -3] })), 5000);
  s.avatar.update(1 / 60, 5010);
  assert.equal(s.avatar.live, true);
  assert.equal(s.body.root.position.x, 4, 'it snaps to the new pose rather than flying in from the old one');
});

test('a missing head reading means a head facing straight along the view', () => {
  const s = setup();
  s.avatar.setState(message(snapshot({ pitch: -.35 }), { head: null }), 0);
  s.avatar.update(1 / 60, 10);
  assert.ok(s.body.head.quaternion.angleTo(s.avatar.seat.quaternion) < 1e-6);
});
