import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { validAssembly } from '../web/object-protocol.js';
import {
  BUILTINS, Library, LIBRARY_KEY, MAX_SAVED, normalizeName, shapeHash, specOfObject, templateOf,
} from '../web/library.js';

// Node doesn't consume the browser import map; resolve the vendored three.js for the scene-object tests.
async function load(name) {
  const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
  const protocol = new URL('../web/object-protocol.js', import.meta.url).href;
  const source = (await readFile(new URL(`../web/${name}.js`, import.meta.url), 'utf8'))
    .replaceAll("from 'three'", `from '${three}'`).replaceAll("from './object-protocol.js'", `from '${protocol}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
}

const stool = (id = 'generated-abc', name = 'Stool', dx = 0) => ({
  version: 1, id, name, position: [3, 0, -2], quaternion: [0, 0, 0, 1],
  parts: [
    { id: 'seat', shape: 'cylinder', size: [.4, .06, .4], position: [dx, .5, 0], quaternion: [0, 0, 0, 1], color: '#4c6ef5' },
    { id: 'leg', shape: 'box', size: [.06, .47, .06], position: [dx, .235, 0], quaternion: [0, 0, 0, 1], color: '#a16b42' },
  ],
});

function bounds(spec) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  const box = new THREE.Box3();
  for (const p of spec.parts) {
    box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(...p.size));
    box.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...p.position), new THREE.Quaternion(...p.quaternion), new THREE.Vector3(1, 1, 1)));
    for (let i = 0; i < 3; i++) {
      low[i] = Math.min(low[i], box.min.getComponent(i));
      high[i] = Math.max(high[i], box.max.getComponent(i));
    }
  }
  return { low, high };
}

test('the built-ins are the ten from the plan: valid, grounded, centered and made of the four primitives', () => {
  assert.deepEqual(BUILTINS.map(e => e.id), ['cube', 'sphere', 'cylinder', 'cone', 'plank', 'wall', 'chair', 'table', 'tree', 'house']);
  for (const entry of BUILTINS) {
    assert.ok(validAssembly(entry.spec), entry.id);
    assert.equal(entry.source, 'builtin');
    assert.ok(entry.spec.parts.every(p => ['box', 'sphere', 'cylinder', 'cone'].includes(p.shape)));
    const { low, high } = bounds(entry.spec);
    assert.ok(Math.abs(low[1]) < 1e-3, `${entry.id} rests on the floor (min y ${low[1]})`);
    assert.ok(Math.abs(low[0] + high[0]) < 1e-3 && Math.abs(low[2] + high[2]) < 1e-3, `${entry.id} is centered`);
  }
});

test('a voice object is saved once per shape, grounded and centered, and survives a reload', () => {
  const storage = new MemoryStorage();
  const library = new Library({ storage });
  const first = library.save(stool('generated-1', 'Stool'));
  assert.equal(first.added, true);
  assert.equal(first.entry.source, 'voice');
  assert.equal(library.save(stool('generated-2', 'Another name')).added, false, 'same parts, different id and name: no duplicate');
  assert.equal(library.save(stool('generated-3', 'Stool', .1)).added, false, 'the same shape standing elsewhere is still the same shape');
  assert.equal(library.saved.length, 1);
  const { low, high } = bounds(first.entry.spec);
  assert.ok(Math.abs(low[1]) < 1e-6 && Math.abs(low[0] + high[0]) < 1e-6, 'template is grounded and centered');
  assert.deepEqual(first.entry.spec.position, [0, 0, 0]);

  const reloaded = new Library({ storage });
  assert.deepEqual(reloaded.saved.map(e => [e.id, e.name]), [[first.entry.id, 'Stool']]);
  assert.equal(reloaded.entries()[0].id, first.entry.id, 'saved objects are listed before the built-ins');
});

test('saved objects are capped (oldest go first); broken or blocked storage never breaks the library', () => {
  const storage = new MemoryStorage();
  const library = new Library({ storage });
  for (let i = 0; i < MAX_SAVED + 5; i++) { // a different seat size each time, so every one is a new shape
    const spec = stool(`h-${i}`, `Thing ${i}`);
    spec.parts[0].size = [.1 + i * .01, .06, .4];
    library.save(spec);
  }
  assert.equal(library.saved.length, MAX_SAVED);
  assert.equal(library.saved.at(-1).name, `Thing ${MAX_SAVED + 4}`, 'the newest is kept');
  assert.equal(new Library({ storage }).saved.length, MAX_SAVED);

  storage.setItem(LIBRARY_KEY, '{not json');
  assert.equal(new Library({ storage }).saved.length, 0);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const fragile = new Library({ storage: blocked });
  assert.equal(fragile.save(stool()).added, true, 'kept in memory for this visit');
  assert.equal(new Library({ storage: null }).entries().length, BUILTINS.length);
});

test('rename and remove apply to saved objects only; built-ins are fixed', () => {
  const library = new Library({ storage: new MemoryStorage() });
  const { entry } = library.save(stool());
  assert.equal(library.rename(entry.id, '  Bar stool  '), true);
  assert.equal(library.get(entry.id).name, 'Bar stool');
  assert.equal(library.get(entry.id).spec.name, 'Bar stool');
  assert.equal(library.rename(entry.id, '   '), false);
  assert.equal(library.rename('chair', 'Throne'), false);
  assert.equal(library.remove('chair'), false);
  assert.equal(library.remove(entry.id), true);
  assert.equal(library.get(entry.id), null);
});

test('adding from the library creates a fresh instance id every time, never the entry id', () => {
  const library = new Library({ storage: null, random: () => .5 });
  const a = library.instantiate('chair');
  const b = library.instantiate('chair');
  assert.ok(validAssembly(a) && validAssembly(b));
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, 'chair');
  assert.match(a.id, /^lib-chair-/);
  assert.deepEqual(a.parts, library.get('chair').spec.parts);
  assert.notEqual(a.parts, library.get('chair').spec.parts, 'a copy, not shared with the template');
  assert.throws(() => library.instantiate('missing'), /no longer in the library/);
});

test('a request that names an entry outright matches it; a detailed description goes to Muse', () => {
  const library = new Library({ storage: null });
  assert.equal(library.match('a chair')?.id, 'chair');
  assert.equal(library.match('Make another tree, please!')?.id, 'tree');
  assert.equal(library.match('chairs')?.id, 'chair');
  assert.equal(library.match('build me a HOUSE')?.id, 'house');
  assert.equal(library.match('a blue chair with wooden legs'), null);
  assert.equal(library.match('undo'), null);
  assert.equal(library.match('   '), null);
  const { entry } = library.save(stool('generated-9', 'Chair'));
  assert.equal(library.match('a chair')?.id, entry.id, 'a saved object wins over the built-in of the same name');
  assert.equal(normalizeName('The glass'), 'glass', 'double-s words are not singularized');
});

test('the spoken wake phrase is ignored, as the voice service strips it, without hiding an object named Mirror', () => {
  const library = new Library({ storage: null });
  assert.equal(library.match('Mirror mirror, make a chair.')?.id, 'chair');
  assert.equal(library.match('mirror, mirror on the wall, build me a tree')?.id, 'tree');
  assert.equal(library.match('Mirror mirror, make a blue chair with wooden legs'), null, 'details still go to Muse');
  const { entry } = library.save({ ...stool('generated-m', 'Mirror') });
  assert.equal(library.match('a mirror')?.id, entry.id);
  assert.equal(library.match('mirror mirror, make a mirror')?.id, entry.id);
});

test('export and import round-trip saved objects; invalid entries are skipped', () => {
  const source = new Library({ storage: null });
  source.save(stool('g-1', 'Stool'));
  const spec = stool('g-2', 'Lamp');
  spec.parts[0].color = '#f4c95d';
  source.save(spec);
  const target = new Library({ storage: new MemoryStorage() });
  assert.deepEqual(target.importJSON(source.exportJSON()), { added: 2, skipped: 0 });
  assert.deepEqual(target.importJSON(source.exportJSON()), { added: 0, skipped: 2 }, 'importing twice adds nothing');
  assert.deepEqual(new Library({ storage: null }).importJSON(JSON.stringify(stool())), { added: 1, skipped: 0 }, 'a bare assembly spec');
  assert.deepEqual(new Library({ storage: null }).importJSON(JSON.stringify([{ name: 'bad', spec: { version: 1 } }, stool()])),
    { added: 1, skipped: 1 });
  assert.throws(() => target.importJSON('not json'));
});

test('templates and hashes ignore pose and id; a rotated part is grounded by its rotated bounds', () => {
  assert.equal(shapeHash(stool('a', 'A')), shapeHash({ ...stool('b', 'B'), position: [9, 9, 9] }));
  const tilted = { ...stool(), parts: [{ id: 'p', shape: 'box', size: [1, .1, .1], position: [0, 2, 0], quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2], color: '#ffffff' }] };
  const { low } = bounds(templateOf(tilted));
  assert.ok(Math.abs(low[1]) < 1e-3, 'a box stood on end touches the floor');
});

test('duplicating: a starter block becomes an equivalent box; a scaled object keeps its scale', async () => {
  const block = new THREE.Mesh(new THREE.BoxGeometry(.4, .6, .3), new THREE.MeshStandardMaterial({ color: 0x4c6ef5 }));
  block.scale.set(2, 1, 1);
  const spec = specOfObject(block);
  assert.ok(validAssembly(spec));
  assert.deepEqual(spec.parts[0].size.map(v => +v.toFixed(6)), [.8, .6, .3]);
  assert.equal(spec.parts[0].color, '#4c6ef5');

  const { Objects } = await load('objects');
  const container = new THREE.Group();
  const interaction = { register() {}, unregister() {} };
  const objects = new Objects(container, interaction);
  const root = objects.add(stool(), { place: false });
  root.scale.setScalar(2);
  const copy = specOfObject(root);
  assert.equal(copy.parts[0].size[0], .8);
  assert.equal(copy.parts[0].position[1], 1);
});

test('a library add goes through Objects.add (so it syncs) and a duplicate lands beside its original', async () => {
  const { Objects } = await load('objects');
  const container = new THREE.Group();
  const objects = new Objects(container, { register() {}, unregister() {} });
  const added = [];
  objects.onAdd = root => added.push(root.userData.id);
  const library = new Library({ storage: null });
  const table = objects.add(library.instantiate('table'), { near: [2, 2] });
  assert.equal(added.length, 1, 'onAdd fired: this is what sends op:add to the other laptop');
  assert.match(added[0], /^lib-table-/);
  const copy = objects.add({ ...specOfObject(table), id: 'copy-1' }, { near: [table.position.x, table.position.z] });
  const gap = Math.hypot(copy.position.x - table.position.x, copy.position.z - table.position.z);
  assert.ok(gap > .3 && gap < 1.5, `next to the original, not on top of it or across the room (${gap.toFixed(2)} m)`);
  assert.ok(Math.hypot(table.position.x - 2, table.position.z - 2) < .1, 'near places around the given point');
});

// A minimal DOM for VoiceUI: just the elements it looks up, with event listeners.
function fakeDom() {
  const make = () => {
    const node = new EventTarget();
    Object.assign(node, { value: '', textContent: '', disabled: false, setAttribute() {}, setPointerCapture() {} });
    return node;
  };
  const nodes = Object.fromEntries(['voice-status', 'object-description', 'voice-record', 'voice-build', 'voice-undo', 'voice-form']
    .map(id => [id, make()]));
  const parent = { appendChild() {} };
  globalThis.document = { getElementById: id => nodes[id], createElement: make, body: parent, head: parent };
  globalThis.window = new EventTarget();
  return nodes;
}

class FakeSocket {
  sent = [];
  send(payload) { this.sent.push(payload); }
  receive(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
  close() { this.onclose?.(); }
}

test('voice UI: a library name is built with no Muse call (even offline); other text goes to Muse; Muse objects are saved', async context => {
  context.mock.method(globalThis, 'WebSocket', function () { return new FakeSocket(); });
  const nodes = fakeDom();
  context.after(() => { delete globalThis.document; delete globalThis.window; });
  const { VoiceUI } = await import('../web/voice-ui.js');
  const added = [];
  const objects = { history: [], add(spec) { added.push(spec); return { name: spec.name, children: spec.parts }; } };
  const library = new Library({ storage: null });
  let libraryChanged = 0;
  const ui = new VoiceUI('ws://localhost:8767', objects, library, { onLibraryChange: () => libraryChanged++ });
  const builds = [];
  ui.onBuild = (phase, root) => builds.push(root ? `${phase}:${root.name}` : phase); // the dust-cloud hook in main.js
  context.after(() => ui.voice.close());
  const sentGenerates = () => ui.voice.socket.sent.filter(m => typeof m === 'string').map(JSON.parse).filter(m => m.type === 'generate');

  nodes['object-description'].value = 'a table';
  ui.refresh();
  assert.equal(nodes['voice-build'].disabled, false, 'Build works for a library name while the voice service is offline');
  ui.request('a table');
  assert.equal(added.length, 1);
  assert.match(added[0].id, /^lib-table-/);
  assert.match(nodes['voice-status'].textContent, /from the library/);

  ui.voice.socket.receive({ type: 'ready', configured: true });
  ui.event({ type: 'status', stage: 'transcribing' }); // the spoken request starts the dust cloud
  ui.event({ type: 'transcript', text: 'Mirror mirror, make another tree' });
  assert.equal(added.at(-1).name, 'Tree', 'a spoken library name is matched after transcription, wake phrase and all');
  assert.equal(sentGenerates().length, 0, 'Muse was never asked');
  assert.deepEqual(builds.slice(-2), ['start', 'done:Tree'], 'the dust cloud finishes at the library object instead of swirling forever');

  ui.event({ type: 'transcript', text: 'a blue chair with wooden legs' });
  assert.deepEqual(sentGenerates().map(m => m.text), ['a blue chair with wooden legs']);

  ui.voice.socket.receive({ type: 'object', spec: stool('generated-77', 'Blue stool'), seconds: 3.2 });
  assert.equal(library.saved.length, 1);
  assert.equal(library.saved[0].name, 'Blue stool');
  assert.equal(libraryChanged, 1);
  assert.match(nodes['voice-status'].textContent, /saved to the library/);
});
