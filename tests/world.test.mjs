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
  presets: url('presets'), 'set-scene': 'data:text/javascript,export const buildSetScene=()=>{}', 'set-layout': url('set-layout'),
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
  await readFile(new URL(`../web/presets/cyberpunk/${preset.thumbnail}`, import.meta.url)); // the card image exists
});
