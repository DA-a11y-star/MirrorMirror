import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { load } from './load.mjs';

const { SceneSync } = await load('sync');

const IDENTITY = [0, 0, 0, 1];

// Three blocks in a row, owned by `userId`'s laptop (the host is 'A').
function setup(userId = 'A') {
  const group = new THREE.Group();
  const blocks = [0, 1, 2].map(i => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(.4, .4, .4), new THREE.MeshStandardMaterial({ color: 0xe76f51 }));
    mesh.position.set(i, .2, 0);
    mesh.userData.id = `b${i + 1}`;
    group.add(mesh);
    return mesh;
  });
  const sync = new SceneSync(group, { userId });
  const clock = { now: 1000 };
  // Advance the fake clock in 60 fps frames, with `mine` = the ids this laptop holds.
  const run = (ms, mine = new Set()) => {
    for (let spent = 0; spent < ms; spent += 1000 / 60) {
      clock.now += 1000 / 60;
      sync.update(1 / 60, clock.now, mine);
    }
  };
  return { sync, blocks, clock, run };
}
const held = (user, ...ids) => ({
  type: 'state', user, seq: 1, held: ids.map(id => typeof id === 'string' ? { id, pos: [5, .2, 0], quat: IDENTITY } : id),
});
const sceneAt = (id, x, user = 'A') => ({ type: 'scene', user, seq: 1, objects: [{ id, pos: [x, .2, 0], quat: IDENTITY }] });

test('a block someone else holds eases toward their stream and is marked as theirs', () => {
  const s = setup('A');
  s.sync.applyState(held('B', 'b1'), s.clock.now, new Set());
  assert.equal(s.sync.holders.get('b1'), 'B');
  s.run(1000 / 60);
  assert.ok(s.blocks[0].position.x > 0 && s.blocks[0].position.x < 5, 'moves part of the way in one frame, not a jump');
  s.run(500);
  assert.ok(Math.abs(s.blocks[0].position.x - 5) < .01);
  assert.deepEqual(s.blocks[1].position.toArray(), [1, .2, 0], 'other blocks are untouched');
});

test('when the holder lets go the block is free again and still settles on its final pose', () => {
  const s = setup('A');
  s.sync.applyState(held('B', 'b1'), s.clock.now, new Set());
  s.run(100);
  s.sync.applyState(held('B'), s.clock.now, new Set());
  assert.equal(s.sync.holders.size, 0);
  assert.equal(s.sync.targets.size, 1, 'still easing toward where it was dropped');
  s.run(1000);
  assert.equal(s.sync.targets.size, 0);
  assert.deepEqual(s.blocks[0].position.toArray(), [5, .2, 0]);
});

test('both users grabbing the same block: the lower user id keeps it', () => {
  const a = setup('A');
  assert.deepEqual(a.sync.applyState(held('B', 'b1'), a.clock.now, new Set(['b1'])), []);
  assert.equal(a.sync.holders.has('b1'), false, 'A keeps its own grab; the claim is ignored');
  assert.equal(a.sync.targets.size, 0);

  const b = setup('B');
  assert.deepEqual(b.sync.applyState(held('A', 'b1'), b.clock.now, new Set(['b1'])), ['b1']);
  assert.equal(b.sync.holders.get('b1'), 'A');
  assert.deepEqual(b.sync.applyState(held('A', 'b2'), b.clock.now, new Set(['b1'])), []);
});

test('only the host snapshot moves idle blocks, and only on the other laptop', () => {
  const b = setup('B');
  b.sync.applyScene(sceneAt('b1', 3), b.clock.now, new Set());
  b.run(500);
  assert.ok(Math.abs(b.blocks[0].position.x - 3) < .01);
  b.sync.applyScene(sceneAt('b2', 4, 'C'), b.clock.now, new Set());
  assert.equal(b.sync.targets.has('b2'), false, 'a snapshot from anyone but the host is ignored');
  b.sync.applyScene(sceneAt('b9', 4), b.clock.now, new Set());
  assert.equal(b.sync.targets.has('b9'), false, 'unknown blocks are ignored');

  const a = setup('A');
  a.sync.applyScene(sceneAt('b1', 3), a.clock.now, new Set());
  assert.equal(a.sync.targets.size, 0, 'the host is the authority and never takes its own scene back');
});

test('the host snapshot never overrides a block that is held, by us or by them', () => {
  const s = setup('B');
  s.sync.applyScene(sceneAt('b1', 3), s.clock.now, new Set(['b1']));
  assert.equal(s.sync.targets.size, 0, 'held by us');
  s.sync.applyState(held('A', 'b2'), s.clock.now, new Set());
  s.sync.applyScene(sceneAt('b2', -3), s.clock.now, new Set());
  assert.deepEqual(s.sync.targets.get('b2').pos.toArray(), [5, .2, 0], 'held by them: their stream wins');
});

test('right after we let go, older host snapshots cannot pull the block back', () => {
  const s = setup('B');
  s.run(100, new Set(['b1']));
  s.run(1000 / 60, new Set()); // released
  s.sync.applyScene(sceneAt('b1', -9), s.clock.now, new Set());
  assert.equal(s.sync.targets.size, 0, 'inside the settle window');
  s.run(500);
  s.sync.applyScene(sceneAt('b1', -9), s.clock.now, new Set());
  assert.equal(s.sync.targets.size, 1, 'after it, the host is the truth again');
});

test('grabbing a block that was still easing toward a remote pose takes it over', () => {
  const s = setup('B');
  s.sync.applyState(held('A', 'b1'), s.clock.now, new Set());
  s.sync.applyState(held('A'), s.clock.now, new Set());
  s.run(50);
  const here = s.blocks[0].position.clone();
  s.run(200, new Set(['b1']));
  assert.equal(s.sync.targets.size, 0);
  assert.ok(s.blocks[0].position.distanceTo(here) < 1e-10, 'the remote easing stops; the local grab moves it');
});

test('a laptop that goes quiet loses its holds', () => {
  const s = setup('A');
  s.sync.applyState(held('B', 'b1'), s.clock.now, new Set());
  s.run(500);
  assert.equal(s.sync.holders.has('b1'), true);
  s.run(500);
  assert.equal(s.sync.holders.size, 0);
});

test('an unregistered object cannot break relay snapshots or shared block ownership', () => {
  const s = setup('A');
  const local = new THREE.Group();
  local.userData.id = 'generated-local-chair';
  s.blocks[0].parent.add(local);
  const mine = new Set(['b1', local.userData.id]);
  assert.deepEqual(s.sync.snapshotHeld(mine).map(pose => pose.id), ['b1']);
  s.run(100, mine);
  assert.equal(s.sync.sceneSnapshot(s.clock.now).objects.length, 3);
  assert.deepEqual(s.sync.applyState(held('B', 'b1'), s.clock.now, mine), []);
  assert.equal(s.sync.holders.has('b1'), false, 'the lower-user-id ownership rule is preserved');
});

test('snapshots carry every block, and the scene goes out about every 100 ms from the host only', () => {
  const a = setup('A');
  a.blocks[1].position.set(1.23456789, .2, 0);
  const first = a.sync.sceneSnapshot(1000);
  assert.equal(first.type, 'scene');
  assert.deepEqual(first.objects.map(o => o.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(first.objects[1].pos, [1.2346, .2, 0]);
  assert.deepEqual(Object.keys(first.objects[0]).sort(), ['color', 'id', 'kind', 'pos', 'quat', 'scale']);
  assert.equal(a.sync.sceneSnapshot(1050), null);
  assert.ok(a.sync.sceneSnapshot(1100));
  assert.equal(setup('B').sync.sceneSnapshot(1000), null);

  assert.deepEqual(a.sync.snapshotHeld(new Set(['b2'])), [{ id: 'b2', pos: [1.2346, .2, 0], quat: IDENTITY }]);
  assert.deepEqual(a.sync.snapshotHeld(new Set()), []);
});
