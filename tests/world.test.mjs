import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// world.js imports three and sibling modules; resolve them the way the browser import map would.
async function load(name, imports = {}) {
  const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
  let source = (await readFile(new URL(`../web/${name}.js`, import.meta.url), 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  source = source.replaceAll('import.meta.url', JSON.stringify(new URL(`../web/${name}.js`, import.meta.url).href)); // a data: module has no base URL
  for (const [file, url] of Object.entries(imports)) source = source.replaceAll(`from './${file}.js'`, `from '${url}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const url = file => new URL(`../web/${file}.js`, import.meta.url).href;
const { worldSeed, presetUrl } = await load('world', {
  presets: url('presets'), 'set-scene': 'data:text/javascript,export const buildSetScene=()=>{}', 'set-layout': url('set-layout'), floor: url('floor'),
});

test('worldSeed is stable (both laptops build the same world) and differs per preset', () => {
  assert.equal(worldSeed('city'), worldSeed('city'));
  const seeds = ['workshop', 'forest', 'city', 'ut-austin'].map(worldSeed);
  assert.equal(new Set(seeds).size, 4);
  assert.ok(seeds.every(s => Number.isInteger(s) && s >= 0 && s < 2 ** 32));
});

test('presetUrl only accepts plain preset ids, never a path', () => {
  assert.ok(presetUrl('forest').endsWith('/presets/forest/preset.json'));
  for (const bad of ['', '../x', 'a/b', 'A', 'x.json', null, undefined, 'a'.repeat(60)]) {
    assert.throws(() => presetUrl(bad), /Bad preset id/, String(bad));
  }
});

test('every preset in the registry has a folder the workspace can load', async () => {
  const registry = JSON.parse(await readFile(new URL('../web/presets/index.json', import.meta.url), 'utf8'));
  for (const id of [...registry.presets, registry.background].filter(Boolean)) {
    const raw = JSON.parse(await readFile(new URL(`../web/presets/${id}/preset.json`, import.meta.url), 'utf8'));
    assert.equal(raw.id, id);
    assert.ok(presetUrl(id).includes(`/presets/${id}/`));
  }
});

test('the cyberpunk preset is backed by the model set in sets.js (its model file and credit exist)', async () => {
  const setsSource = await readFile(new URL('../web/sets.js', import.meta.url), 'utf8');
  assert.match(setsSource, /\bcyberpunk: \{/);
  const model = /model: '([^']+)'/.exec(setsSource)[1];
  const glb = await readFile(new URL(`../web/${model}`, import.meta.url));
  assert.equal(glb.subarray(0, 4).toString(), 'glTF', 'a binary glTF file');
  const credits = await readFile(new URL('../web/assets/CREDITS.md', import.meta.url), 'utf8');
  assert.ok(credits.includes('cyberpunk/'));
  const preset = JSON.parse(await readFile(new URL('../web/presets/cyberpunk/preset.json', import.meta.url), 'utf8'));
  assert.equal(preset.id, 'cyberpunk');
  assert.equal(preset.thumbnail, undefined, 'the mirror is rendered from the current world, not the obsolete miniature image');
});

// ---- floors ----
const { floorRects, makeFloorAt } = await import('../web/floor.js');
const preset = {
  objects: {
    deck: [{ shape: 'box', size: [16, 0.3, 16], pos: [0, 0.15, 0], rot: [0, 0, 0] }],
    pole: [{ shape: 'cylinder', size: [0.2, 3, 0.2], pos: [0, 1.5, 0], rot: [0, 0, 0] }],
    wall: [{ shape: 'box', size: [6, 3, 0.3], pos: [0, 1.5, 0], rot: [0, 0, 0] }],
    path: [{ shape: 'box', size: [4, 0.06, 30], pos: [0, 0.03, 0], rot: [0, 0, 0] }],
    tilted: [{ shape: 'box', size: [6, 0.3, 6], pos: [0, 0.15, 0], rot: [10, 0, 0] }],
  },
};
const at = (object, x, y, z, yaw = 0, scale = 1, stretch = 1) => ({ object, x, y, z, yaw, scale, stretch });

test('floor: a deck lifts the floor to its top, only inside its edge', () => {
  const floorAt = makeFloorAt(floorRects(preset, [at('deck', 0, 0, 0)]));
  assert.equal(floorAt(0, 0), 0.3);
  assert.equal(floorAt(7.9, -7.9), 0.3);
  assert.equal(floorAt(8.1, 0), 0, 'off the deck is the ground again');
  assert.equal(floorAt(0, 8.1), 0);
});

test('floor: poles, walls and tilted boxes are not floors; a thin path is', () => {
  const floorAt = makeFloorAt(floorRects(preset, [at('pole', 0, 0, 0), at('wall', 5, 0, 0), at('tilted', -5, 0, 0)]));
  for (const [x, z] of [[0, 0], [5, 0], [-5, 0]]) assert.equal(floorAt(x, z), 0, `(${x}, ${z})`);
  const path = makeFloorAt(floorRects(preset, [at('path', 0, 0, 0)]));
  assert.equal(path(0, 14), 0.06);
  assert.equal(path(3, 0), 0, 'beside a 4 m wide path');
});

test('floor: rotation, scale and the instance height are honoured', () => {
  // A 16 m deck turned 90 degrees about a corner offset, scaled 0.5 (8 m), standing on a 0.4 m platform.
  const floorAt = makeFloorAt(floorRects(preset, [at('deck', 10, 0.4, -4, 90, 0.5)]));
  assert.ok(Math.abs(floorAt(10, -4) - 0.55) < 1e-9, 'centre: instance y + top * scale');
  assert.equal(floorAt(13.9, -4), 0.55);
  assert.equal(floorAt(14.2, -4), 0);
  const long = makeFloorAt(floorRects(preset, [at('path', 0, 0, 0, 90)]));
  assert.equal(long(14, 0), 0.06, 'a path turned 90 degrees now runs along x');
  assert.equal(long(0, 14), 0);
});

test('floor: the highest surface wins where floors overlap', () => {
  const floorAt = makeFloorAt(floorRects(preset, [at('path', 0, 0, 0), at('deck', 0, 0, 0)]));
  assert.equal(floorAt(0, 0), 0.3);
});
