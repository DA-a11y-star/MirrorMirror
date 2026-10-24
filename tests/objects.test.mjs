import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { encodeWav } from '../web/voice.js';

async function load(name) {
  const path = new URL(`../web/${name}.js`, import.meta.url);
  const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
  const source = (await readFile(path, 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const { Objects, createAssembly } = await load('objects');
const { Interaction } = await load('interaction');

function spec() {
  return {
    version: 1, id: 'generated-chair', name: 'Chair', position: [0, 0, 0], quaternion: [0, 0, 0, 1],
    parts: [
      { id: 'seat', shape: 'box', size: [.5, .1, .5], position: [0, .45, 0], quaternion: [0, 0, 0, 1], color: '#4c6ef5' },
      { id: 'leg', shape: 'cylinder', size: [.1, .4, .1], position: [.2, .2, .2], quaternion: [0, 0, 0, 1], color: '#a16b42' },
    ],
  };
}

function setup() {
  const blocks = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(55, 1, .05, 100);
  camera.position.set(0, .45, 3);
  camera.updateMatrixWorld();
  const hands = { slots: [{ side: 'right', anchor: [new THREE.Vector3(0, .5, 2), new THREE.Vector3(0, .5, 2)] }] };
  const interaction = new Interaction(blocks, camera, hands);
  const objects = new Objects(blocks, interaction);
  return { blocks, camera, hands, interaction, objects };
}

test('dynamic compound objects raycast to their root, highlight every part, move together and stay grounded', () => {
  const s = setup();
  const root = s.objects.add(spec());
  const gaze = { x: .5, y: .5, conf: 1 };
  s.interaction.update(gaze, true, 0);
  s.interaction.update(gaze, true, 100);
  assert.equal(s.interaction.target, root);
  assert.ok(root.children.every(mesh => mesh.material.emissive.getHex() === 0xf4c95d));
  const local = root.children.map(mesh => mesh.position.clone());
  const start = root.position.clone();
  s.interaction.setFrame({ hands: [{ side: 'right', pinching: true }] });
  s.interaction.update(gaze, true, 200);
  assert.equal(s.interaction.grabs.get('right').mesh, root);
  assert.ok(root.position.distanceTo(start) < 1e-9);
  for (const anchor of s.hands.slots[0].anchor) anchor.set(.2, -1, 2);
  s.interaction.update(null, true, 300);
  assert.ok(root.position.x > .1);
  assert.ok(new THREE.Box3().setFromObject(root).min.y >= -1e-9);
  root.children.forEach((mesh, i) => assert.ok(mesh.position.distanceTo(local[i]) < 1e-9));
  assert.equal(s.objects.undo(), true);
  assert.equal(s.interaction.grabs.size, 0);
  assert.equal(s.interaction.target, null);
  assert.equal(s.interaction.baseMaterials.size, 0);
  assert.equal(s.blocks.children.length, 0);
});

test('placement avoids occupied bounds and undo disposes materials without invalidating shared geometries', () => {
  const s = setup();
  const a = s.objects.add(spec());
  const b = s.objects.add({ ...spec(), id: 'second' });
  assert.equal(new THREE.Box3().setFromObject(a).intersectsBox(new THREE.Box3().setFromObject(b)), false);
  const geometry = b.children[0].geometry;
  assert.equal(a.children[0].geometry, geometry);
  let disposed = 0;
  b.children.forEach(mesh => mesh.material.addEventListener('dispose', () => disposed++));
  s.objects.undo();
  assert.equal(disposed, 2);
  assert.equal(s.blocks.children[0], a);
  assert.equal(s.interaction.baseMaterials.size, 2);
});

test('remote gaze feedback handles compound roots and restores every part when it ends', () => {
  const s = setup();
  const root = s.objects.add(spec());
  s.interaction.setRemote(new Set(), new Set([root.userData.id]));
  s.interaction.highlight();
  assert.ok(root.children.every(mesh => mesh.material.emissive.getHex() === 0x8f7cf0));
  s.interaction.setRemote(new Set(), new Set());
  s.interaction.highlight();
  assert.ok(root.children.every(mesh => mesh.material.emissive.getHex() === 0));
});

test('fast-motion carry grace remains available when grabbing a generated assembly', () => {
  const s = setup();
  s.objects.add(spec());
  const gaze = { x: .5, y: .5, conf: 1 };
  const slot = s.hands.slots[0];
  slot.velocity = Array.from({ length: 21 }, () => new THREE.Vector3(1, 0, 0));
  s.interaction.update(gaze, true, 0);
  s.interaction.update(gaze, true, 100);
  s.interaction.setFrame({ hands: [{ side: 'right', pinching: true }] });
  s.interaction.update(gaze, true, 200);
  s.interaction.update(gaze, true, 300);
  s.interaction.setFrame({ hands: [{ side: 'right', pinching: false }] });
  s.interaction.update(gaze, true, 400);
  assert.equal(s.interaction.grabs.size, 1, 'blurred open reading does not drop a fast carry');
  s.interaction.update(gaze, true, 901);
  assert.equal(s.interaction.grabs.size, 0, 'a sustained release still lets go');
});

test('primitive bounding dimensions match the specification for all supported shapes', () => {
  for (const shape of ['box', 'sphere', 'cylinder', 'cone']) {
    const data = spec();
    data.parts = [{ ...data.parts[0], shape, size: [.4, .8, .6], position: [0, .4, 0] }];
    const root = createAssembly(data);
    const bounds = new THREE.Box3().setFromObject(root);
    const size = bounds.getSize(new THREE.Vector3());
    assert.ok(size.distanceTo(new THREE.Vector3(.4, .8, .6)) < 1e-6);
    assert.ok(Math.abs(bounds.min.y) < 1e-6);
  }
});

test('WAV encoder produces the required 24 kHz mono 16-bit little-endian PCM header and clamps samples', () => {
  const buffer = encodeWav(new Float32Array([-2, -1, 0, 1, 2]));
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 10);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => view.getInt16(44+i*2, true)), [-32768, -32768, 0, 32767, 32767]);
});
