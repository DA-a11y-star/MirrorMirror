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
const { RemoteAvatar, headQuaternion } = await load('avatar');

// Stands in for the Hands instance reserved for the peer.
class FakeHands {
  constructor() { this.frame = null; this.camera = null; }
  setFrame(frame) { this.frame = frame; }
  update(dt, camera) { this.camera = camera; }
}
const FACING_A = [0, 1, 0, 0]; // base camera at the far end, looking toward +z (a half turn about y)
const message = (pos = [0, 1.6, -3], extra = {}) => ({
  avatar: { pos, quat: FACING_A }, head: { quat: [0, 0, 0, 1] }, target: 'b1',
  hands: [{ side: 'right', pinch: .5, lm: [] }], ...extra,
});

function setup() {
  const scene = new THREE.Scene();
  const hands = new FakeHands();
  const avatar = new RemoteAvatar(scene, 'B', hands);
  return { scene, hands, avatar };
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

test('the avatar sits at the sender\'s eye position with the bust below it, and draws their hands through their seat', () => {
  const s = setup();
  s.avatar.setState(message(), 0);
  s.avatar.update(1 / 60, 10);
  assert.equal(s.avatar.live, true);
  assert.deepEqual(s.avatar.head.position.toArray(), [0, 1.6, -3]);
  assert.ok(Math.abs(s.avatar.torso.position.y - (1.6 - .52)) < 1e-9);
  assert.deepEqual(s.hands.frame, message().hands);
  assert.equal(s.hands.camera, s.avatar.seat, 'remote landmarks are placed relative to the remote user\'s own view');
  assert.equal(s.avatar.looking, 'b1');
});

test('the head turns with the sender\'s head, on top of their view direction', () => {
  const s = setup();
  s.avatar.setState(message([0, 1.6, -3], { head: { quat: [0, -Math.sin(.25), 0, Math.cos(.25)] } }), 0);
  s.avatar.update(1 / 60, 10);
  const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(s.avatar.head.quaternion);
  // They look toward +z (at the other user); turning to their right is toward world -x. The tracker's .25 rad
  // half-angle is a half-turn of .5 rad: sin = .48, cos = .88.
  assert.ok(Math.abs(facing.x + Math.sin(.5)) < 1e-9 && Math.abs(facing.z - Math.cos(.5)) < 1e-9, `got ${facing.toArray()}`);
});

test('moves ease toward the newest pose instead of jumping', () => {
  const s = setup();
  s.avatar.setState(message([0, 1.6, -3]), 0);
  s.avatar.update(1 / 60, 10);
  s.avatar.setState(message([2, 1.6, -3]), 20);
  s.avatar.update(1 / 60, 30);
  assert.ok(s.avatar.head.position.x > 0 && s.avatar.head.position.x < 2);
  for (let i = 0; i < 60; i++) s.avatar.update(1 / 60, 40 + i * 16);
  assert.ok(Math.abs(s.avatar.head.position.x - 2) < .01);
});

test('a peer that goes quiet disappears with its hands, and reappears in place', () => {
  const s = setup();
  s.avatar.setState(message(), 0);
  s.avatar.update(1 / 60, 100);
  s.avatar.update(1 / 60, 900);
  assert.equal(s.avatar.live, false);
  assert.deepEqual(s.hands.frame, []);
  assert.equal(s.avatar.looking, null);
  s.avatar.setState(message([4, 1.6, -3]), 5000);
  s.avatar.update(1 / 60, 5010);
  assert.equal(s.avatar.live, true);
  assert.equal(s.avatar.head.position.x, 4, 'it snaps to the new pose rather than flying in from the old one');
});

test('a missing head reading means a head facing straight along the view', () => {
  const s = setup();
  s.avatar.setState(message([0, 1.6, -3], { head: null }), 0);
  s.avatar.update(1 / 60, 10);
  assert.ok(s.avatar.head.quaternion.angleTo(s.avatar.seat.quaternion) < 1e-9);
});
