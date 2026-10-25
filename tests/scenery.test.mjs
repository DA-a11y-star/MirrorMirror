import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';

// Node doesn't consume the browser import map; load web modules with 'three' and their relative imports resolved.
const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function load(name, imports = {}) {
  let source = (await readFile(new URL(`../web/${name}.js`, import.meta.url), 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  for (const [path, url] of Object.entries(imports)) source = source.replaceAll(`from './${path}.js'`, `from '${url}'`);
  return { module: await import(dataUrl(source)), url: dataUrl(source) };
}
const scenery = await load('scenery');
const { fitScenery, prepareScenery, sceneryStats } = scenery.module;
const { SETS } = (await load('sets', { scenery: scenery.url })).module;

// A lopsided model: a tall box off to one side and a low slab, offset from the origin and sunk below the ground.
function model() {
  const root = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.BoxGeometry(2, 6, 2), new THREE.MeshStandardMaterial());
  tower.position.set(5, 2, -3);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(8, 1, 8), new THREE.MeshStandardMaterial());
  slab.position.set(3, -1, -1);
  root.add(tower, slab);
  return root;
}

test('fitScenery scales the model, stands it on y = 0 and centres its footprint', () => {
  const root = model();
  const before = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const box = fitScenery(root, { scale: 0.5, center: [1, 2] });
  const size = box.getSize(new THREE.Vector3()), middle = box.getCenter(new THREE.Vector3());
  assert.ok(Math.abs(box.min.y) < 1e-9, `lowest point at ${box.min.y}`);
  assert.ok(Math.abs(middle.x - 1) < 1e-9 && Math.abs(middle.z - 2) < 1e-9, `footprint centre ${middle.x}, ${middle.z}`);
  assert.ok(Math.abs(size.x - before.x / 2) < 1e-9 && Math.abs(size.y - before.y / 2) < 1e-9, 'scaled uniformly');
  fitScenery(root, { scale: 0.5, center: [1, 2] });
  assert.ok(Math.abs(new THREE.Box3().setFromObject(root).min.y) < 1e-9, 'fitting twice gives the same result');
});

test('fitScenery floor: the model\'s own walkable height lands on y = 0, even with parts hanging below it', () => {
  const root = model(); // the slab's top is at y = -0.5, but a 6 m tower and the slab's bottom reach lower than that
  const flat = new THREE.Box3().setFromObject(root);
  const box = fitScenery(root, { scale: 2, center: [0, 0], floor: -0.5 });
  const top = box.max.y - (flat.max.y + 0.5) * 2; // where the slab's top surface (y = -0.5) ended up
  assert.ok(Math.abs(top) < 1e-9, `the floor surface is at ${top}`);
  assert.ok(box.min.y < -0.5, 'the part below the floor stays below it instead of being lifted onto it');
  const plain = fitScenery(root, { scale: 2, center: [0, 0] });
  assert.ok(Math.abs(plain.min.y) < 1e-9, 'without a floor the lowest point still stands on y = 0');
  assert.ok(Math.abs(box.min.y - plain.min.y) > 0.5, 'and the two placements differ');
});

test('the Japanese garden is placed on its lawn, at real size, with its measured open spot on the origin', async () => {
  const garden = SETS['japanese-garden'];
  assert.equal(garden.scale, 1);
  assert.ok(garden.floor < -19 && garden.floor > -21, `floor ${garden.floor}`);
  assert.deepEqual(garden.center, [7.75, 0.8]);
  assert.equal(garden.shadows.castShadow, true);
  const preset = JSON.parse(await readFile(new URL('../web/presets/japanese-garden/preset.json', import.meta.url), 'utf8'));
  assert.equal(preset.id, 'japanese-garden', 'the landing card and the model set share an id, which is how Play finds the model');
  assert.deepEqual(preset.objects, {}, 'the world comes from the model, not from invented props');
});

test('the Chinese city is built at 2x so its 2.7 m streets fit the blocks and both users, with its crossroads on the origin', async () => {
  const city = SETS['chinese-city'];
  assert.equal(city.scale, 2, 'at 1x the streets are narrower than the starter blocks plus two users');
  assert.deepEqual(city.center, [0, 9], 'the crossroads is 4.5 model metres short of the model centre in z, so 9 m at 2x');
  assert.equal(city.floor, 0);
  const preset = JSON.parse(await readFile(new URL('../web/presets/chinese-city/preset.json', import.meta.url), 'utf8'));
  assert.equal(preset.id, 'chinese-city', 'the landing card and the model set share an id');
  assert.deepEqual(preset.objects, {});
  const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.ok(ignore.includes('/*.glb'), 'raw model downloads in the repo root must not be committable');
});

test('prepareScenery marks and freezes the model; it receives shadows but casts none unless asked', () => {
  const root = model();
  fitScenery(root, { scale: 2, center: [0, 0] });
  const placed = new THREE.Box3().setFromObject(root);
  prepareScenery(root);
  root.traverse(node => {
    assert.equal(node.userData.scenery, true);
    assert.equal(node.matrixAutoUpdate, false, 'nothing in scenery moves, so nothing is recomputed per frame');
    if (node.isMesh) assert.deepEqual([node.castShadow, node.receiveShadow], [false, true]);
  });
  root.updateMatrixWorld(true);
  assert.ok(new THREE.Box3().setFromObject(root).equals(placed), 'freezing keeps the placement');
  prepareScenery(root, { castShadow: true });
  root.traverse(node => { if (node.isMesh) assert.equal(node.castShadow, true); });
});

test('sceneryStats counts triangles, meshes and distinct materials', () => {
  assert.deepEqual(sceneryStats(model()), { triangles: 24, meshes: 2, materials: 2 });
});

test('every set with a model points at a valid .glb in web/, with a credit, a sane scale and a clear workspace', async () => {
  const credits = await readFile(new URL('../web/assets/CREDITS.md', import.meta.url), 'utf8');
  for (const [id, set] of Object.entries(SETS)) {
    assert.equal(typeof set.name, 'string', id);
    if (!set.model) continue;
    assert.ok(set.scale > 0 && set.scale <= 20, `${id} scale ${set.scale}`);
    assert.ok(set.center.length === 2 && set.center.every(Number.isFinite), `${id} center`);
    assert.ok(!set.workspace || (set.workspace.length === 2 && set.workspace.every(Number.isFinite)), `${id} workspace`);
    assert.match(set.credit, /CC|licen/i, `${id} must credit its model`);
    const folder = set.model.split('/').slice(0, -1).join('/');
    assert.ok(credits.includes(folder.split('/').pop() + '/'), `${folder} is missing from web/assets/CREDITS.md`);
    const file = new URL(`../web/${set.model}`, import.meta.url);
    const bytes = await readFile(file);
    assert.equal(bytes.toString('utf8', 0, 4), 'glTF', `${set.model} is not a GLB`);
    assert.equal(bytes.readUInt32LE(4), 2, 'glTF version 2');
    assert.equal(bytes.readUInt32LE(8), (await stat(file)).size, 'GLB length matches the file (not truncated)');
    const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
    assert.ok(!(json.extensionsRequired ?? []).length, `${id} needs extensions the loader may lack: ${json.extensionsRequired}`);
  }
});
