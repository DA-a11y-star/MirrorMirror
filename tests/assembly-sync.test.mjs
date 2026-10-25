import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { validOp, validScene } from '../web/net.js';
import { validAssembly } from '../web/object-protocol.js';
import { load } from './load.mjs';

const { Objects } = await load('objects');
const { Interaction } = await load('interaction');
const { SceneSync } = await load('sync');

function spec(id = 'generated-chair') {
  return { version: 1, id, name: 'Blue chair', position: [0, 0, 0], quaternion: [0, 0, 0, 1],
    transcript: 'PRIVATE_TRANSCRIPT', prompt: 'PRIVATE_PROMPT', audio: 'PRIVATE_AUDIO',
    parts: [
      { id: 'seat', shape: 'box', size: [.5, .1, .5], position: [0, .45, 0], quaternion: [0, 0, 0, 1], color: '#4c6ef5' },
      { id: 'leg', shape: 'cylinder', size: [.1, .4, .1], position: [.2, .2, .2], quaternion: [0, 0, 0, 1], color: '#a16b42' },
    ] };
}

let seq = 0;
const envelope = (user, msg) => JSON.parse(JSON.stringify({ ...msg, user, seq: ++seq }));
function client(userId) {
  const blocks = new THREE.Group();
  const starter = new THREE.Mesh(new THREE.BoxGeometry(.4, .4, .4), new THREE.MeshStandardMaterial());
  starter.userData.id = 'b1';
  starter.position.set(-2, .2, 0);
  blocks.add(starter);
  const interaction = new Interaction(blocks, new THREE.PerspectiveCamera(), { slots: [] });
  const objects = new Objects(blocks, interaction);
  const sync = new SceneSync(blocks, { userId, objects });
  return { blocks, interaction, objects, sync };
}
function ops(from, to, now = 1000) {
  const sent = [];
  from.sync.flushOps(now, msg => {
    const wire = envelope(from.sync.userId, msg);
    assert.equal(validOp(wire), true);
    to.sync.applyOp(wire);
    sent.push(wire);
    return true;
  });
  return sent;
}
function scene(host, guest, now = 1000, mine = new Set()) {
  const wire = envelope(host.sync.userId, host.sync.sceneSnapshot(now));
  assert.equal(validScene(wire), true);
  guest.sync.applyScene(wire, now, mine);
  return wire;
}

test('host sends only a render recipe; guest reconstructs identical geometry at the selected world transform', () => {
  const a = client('A'), b = client('B');
  const root = a.objects.add(spec());
  root.position.set(1.2, .1, -.7);
  root.rotation.y = .7;
  root.scale.setScalar(1.1);
  const wire = scene(a, b);
  const remote = b.sync.meshes.get(root.userData.id);
  assert.ok(remote);
  assert.deepEqual(remote.position.toArray(), root.position.toArray());
  assert.ok(remote.quaternion.angleTo(root.quaternion) < 1e-7);
  assert.deepEqual(remote.scale.toArray(), root.scale.toArray());
  assert.equal(remote.children.length, root.children.length);
  remote.children.forEach((part, i) => {
    assert.equal(part.geometry.type, root.children[i].geometry.type);
    assert.deepEqual(part.position.toArray(), root.children[i].position.toArray());
    assert.equal(part.material.color.getHex(), root.children[i].material.color.getHex());
  });
  assert.equal(b.objects.history.length, 0, 'receiving an object must not add it to this user’s undo history');
  assert.equal(b.interaction.baseMaterials.size, 3, 'new parts are registered for highlighting immediately');
  assert.doesNotMatch(JSON.stringify(wire), /PRIVATE_|transcript|prompt|audio|MODEL_API_KEY/);
});

test('guest creation survives older scenes and retries until the host acknowledges the exact add operation', () => {
  const a = client('A'), b = client('B');
  const older = envelope('A', a.sync.sceneSnapshot(0));
  const root = b.objects.add(spec());
  b.sync.applyScene(older, 100, new Set());
  assert.equal(b.sync.meshes.get(root.userData.id), root);
  b.sync.flushOps(500, () => false);
  assert.equal(b.sync.pending.size, 1);
  const [add] = ops(b, a, 1000);
  assert.doesNotMatch(JSON.stringify(add), /PRIVATE_|transcript|prompt|audio/);
  assert.equal(a.sync.meshes.size, 2);
  const hostRoot = a.sync.meshes.get(root.userData.id);
  hostRoot.position.x += .3;
  ops(b, a, 1600);
  assert.equal(a.sync.meshes.size, 2, 'add retries are idempotent');
  assert.ok(hostRoot.position.x > root.position.x, 'retry must not reset an object’s current pose');
  scene(a, b, 2000);
  assert.equal(b.sync.pending.size, 0);
  assert.equal(b.blocks.children.length, 2);
  assert.equal(a.objects.history.length, 0);
});

test('generated assemblies use existing ownership arbitration, movement streams and post-release grace', () => {
  const a = client('A'), b = client('B');
  const root = a.objects.add(spec());
  scene(a, b, 0);
  const remote = b.sync.meshes.get(root.userData.id);
  remote.position.set(2, .3, -1);
  const mine = new Set([root.userData.id]);
  const held = b.sync.snapshotHeld(mine);
  assert.deepEqual(held[0].pos, [2, .3, -1]);
  assert.deepEqual(a.sync.applyState({ user: 'B', held }, 100, new Set()), []);
  a.sync.update(.1, 200, new Set());
  assert.ok(root.position.x > 1);
  assert.equal(a.sync.holders.get(root.userData.id), 'B');
  assert.deepEqual(b.sync.applyState({ user: 'A', held }, 200, mine), [root.userData.id]);
  b.sync.holders.clear();
  b.sync.update(.016, 200, mine);
  b.sync.update(.016, 216, new Set());
  scene(a, b, 300);
  assert.equal(b.sync.targets.has(root.userData.id), false, 'old host pose is ignored after release');
});

test('undo sends a deletion; stale scenes cannot cancel it, host tombstones prevent delayed add resurrection', () => {
  const a = client('A'), b = client('B');
  const root = b.objects.add(spec());
  const [add] = ops(b, a, 1000);
  const stale = scene(a, b, 1000);
  assert.equal(b.objects.undo(), true);
  b.sync.applyScene(stale, 1100, new Set());
  assert.equal(b.sync.meshes.has(root.userData.id), false);
  assert.equal(b.sync.pending.get(root.userData.id).op, 'delete');
  ops(b, a, 1200);
  assert.equal(a.sync.meshes.has(root.userData.id), false);
  a.sync.applyOp(add);
  assert.equal(a.sync.meshes.has(root.userData.id), false);
  scene(a, b, 1400);
  assert.equal(b.sync.pending.size, 0);
  assert.equal(a.interaction.baseMaterials.size, 1);
  assert.equal(b.interaction.baseMaterials.size, 1);
});

test('late join and reconnect recover objects and missed deletions from complete host scenes', () => {
  const a = client('A'), b = client('B');
  const root = a.objects.add(spec());
  scene(a, b, 0);
  root.position.set(.8, .2, -.3);
  const late = client('C');
  scene(a, late, 1000);
  assert.deepEqual(late.sync.meshes.get(root.userData.id).position.toArray(), root.position.toArray());
  a.objects.undo();
  scene(a, b, 2000);
  scene(a, late, 3000);
  assert.equal(b.sync.meshes.has(root.userData.id), false);
  assert.equal(late.sync.meshes.has(root.userData.id), false);
});

test('an old empty scene cannot acknowledge an undo before the host has processed it', () => {
  const a = client('A'), b = client('B');
  const empty = envelope('A', a.sync.sceneSnapshot(0));
  const root = b.objects.add(spec());
  ops(b, a, 1000);
  b.objects.undo();
  b.sync.applyScene(empty, 1100, new Set());
  assert.equal(b.sync.pending.get(root.userData.id).op, 'delete');
  ops(b, a, 1200);
  scene(a, b, 1400);
  assert.equal(a.sync.meshes.has(root.userData.id), false);
  assert.equal(b.sync.pending.size, 0);
});

test('a host deletion releases a guest grab and clears easing targets before the next render frame', () => {
  const a = client('A'), b = client('B');
  const root = a.objects.add(spec());
  scene(a, b, 0);
  const remote = b.sync.meshes.get(root.userData.id);
  b.interaction.grabs.set('right', { mesh: remote });
  b.interaction.target = remote;
  a.objects.undo();
  scene(a, b, 1000, new Set([root.userData.id]));
  assert.equal(b.interaction.grabs.size, 0);
  assert.equal(b.interaction.target, null);
  assert.equal(b.sync.targets.has(root.userData.id), false);
  assert.doesNotThrow(() => b.sync.update(.016, 1016, new Set()));
});

test('render protocol rejects malformed primitives, mismatched IDs, duplicate parts and nonfinite transforms', () => {
  assert.equal(validAssembly(spec()), true);
  for (const change of [
    s => { s.parts[0].shape = 'javascript'; }, s => { s.parts[0].size[0] = -1; },
    s => { s.parts[0].quaternion = [0, 0, 0, 0]; }, s => { s.parts[0].position[0] = NaN; },
    s => { s.parts[1].id = s.parts[0].id; }, s => { s.parts = Array(41).fill(s.parts[0]); },
  ]) {
    const s = spec(); change(s); assert.equal(validAssembly(s), false);
  }
  const a = client('A'), b = client('B');
  a.objects.add(spec());
  const [add] = ops(a, b);
  add.obj.spec.id = 'different';
  assert.equal(validOp(add), false);
});

// A realistic voice object: full-precision floats, several parts.
function bigSpec(i, parts = 12) {
  const r = k => Math.abs(Math.sin(i * 12.9898 + k * 78.233));
  return { version: 1, id: `generated-${String(i).padStart(12, '0')}`, name: `Prop number ${i}`, position: [0, 0, 0], quaternion: [0, 0, 0, 1],
    parts: Array.from({ length: parts }, (_, j) => ({ id: `part-${j}`, shape: ['box', 'sphere', 'cylinder', 'cone'][j % 4],
      size: [.1 + r(j) * .4, .1 + r(j + 1) * .4, .1 + r(j + 2) * .4], position: [r(j + 3) - .5, r(j + 4), r(j + 5) - .5],
      quaternion: [0, 0, 0, 1], color: '#4c6ef5' })) };
}
const hasSpec = wire => wire.objects.some(o => o.kind === 'assembly' && 'spec' in o);
const bytes = wire => JSON.stringify(wire).length;

test('steady-state scenes carry poses only, and a joiner gets every recipe the moment it first appears', () => {
  const a = client('A'), b = client('B');
  for (let i = 0; i < 59; i++) a.objects.add(bigSpec(i), { place: false }).position.set(i * .1, 0, -i * .07);
  const full = scene(a, b, 0);
  a.sync.sceneSent(true);
  assert.equal(b.sync.meshes.size, 60);
  assert.ok(bytes(full) < 300_000, `a full 60-object scene is ${bytes(full)} bytes`);

  const steady = scene(a, b, 100);
  assert.equal(hasSpec(steady), false);
  assert.ok(bytes(steady) < 20_000, `a steady-state scene is ${bytes(steady)} bytes`);

  const late = client('C');
  late.sync.applyScene(steady, 150, new Set()); // poses alone can't build anything, and must not throw
  assert.equal(late.sync.meshes.size, 1);
  a.sync.applyState({ user: 'C', held: [] }, 200, new Set()); // first sign of the joiner
  const joined = scene(a, late, 200);
  a.sync.sceneSent(true);
  assert.equal(hasSpec(joined), true);
  assert.equal(late.sync.meshes.size, 60, 'the joiner reconstructs everything');
  const probe = a.blocks.children[30];
  assert.deepEqual(late.sync.meshes.get(probe.userData.id).position.toArray(), probe.position.toArray());

  a.sync.applyState({ user: 'C', held: [] }, 250, new Set()); // a peer we already know doesn't trigger another full scene
  assert.equal(hasSpec(scene(a, late, 300)), false);
});

test('a recipe stays owed until a scene carrying it was delivered, and every recipe is re-sent every couple of seconds', () => {
  const a = client('A'), b = client('B');
  a.objects.add(spec('generated-one'));
  assert.equal(hasSpec(scene(a, b, 0)), true);
  a.sync.sceneSent(false); // backpressure dropped it
  assert.equal(hasSpec(scene(a, b, 100)), true, 'not used up by a scene that never left');
  a.sync.sceneSent(true);
  assert.equal(hasSpec(scene(a, b, 200)), false);
  a.sync.sceneSent(true);
  a.objects.add(spec('generated-two'));
  const next = scene(a, b, 300);
  assert.deepEqual(next.objects.filter(o => 'spec' in o).map(o => o.id), ['generated-two'], 'only the new object brings a recipe');
  a.sync.sceneSent(true);
  assert.equal(hasSpec(scene(a, b, 1900)), false);
  assert.equal(hasSpec(scene(a, b, 2200)), true, 'periodic full scene heals anything that was lost');
});

test('acks and tombstones are broadcast briefly and forgotten, so scenes stay small however long the session runs', () => {
  const a = client('A');
  for (let i = 0; i < 1200; i++) { // two minutes with one guest deletion every 100 ms
    const now = i * 100;
    a.sync.update(.1, now, new Set());
    a.sync.applyOp({ type: 'op', user: 'B', seq: i, opId: `B:${i}`, op: 'delete', obj: { id: `generated-${i}` } });
    const wire = envelope('A', a.sync.sceneSnapshot(now));
    assert.equal(validScene(wire), true);
    assert.ok(wire.acks.length <= 31 && wire.deleted.length <= 51, `${wire.acks.length} acks, ${wire.deleted.length} tombstones at ${now} ms`);
  }
  assert.ok(a.sync.acks.size <= 101, `${a.sync.acks.size} acks kept`);
  assert.ok(a.sync.deleted.size <= 601, `${a.sync.deleted.size} tombstones kept`);
});
