import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LIMITS, loadRegistry, parsePreset, PRESET_FORMAT, PresetError, registryEntryUrl, resolveImageUrl, validatePreset,
} from '../web/presets.js';

const WEB = new URL('../web/', import.meta.url);
const ORIGIN = 'http://mirror.test/';
// Serves web/ as if over HTTP, the way the page is always loaded.
const diskFetch = async url => {
  const path = fileURLToPath(new URL(String(url).slice(ORIGIN.length), WEB));
  if (!existsSync(path)) return { ok: false, status: 404, url: String(url), text: async () => '' };
  return { ok: true, status: 200, url: String(url), text: async () => readFileSync(path, 'utf8') };
};
const BOX = { shape: 'box', size: [1, 1, 1], pos: [0, .5, 0], color: '#e76f51' };
const minimal = (extra = {}) => ({
  format: PRESET_FORMAT, version: 1, id: 'demo', name: 'Demo',
  environment: { sky: ['#112233', '#445566'], fog: ['#445566', 5, 40], ground: '#336633' },
  objects: { crate: [BOX] },
  scatter: [{ objects: ['crate'], count: [3, 5], radius: [2, 10] }],
  ...extra,
});
const BASE = 'http://mirror.test/presets/demo/preset.json';
const rejects = (raw, pattern) => assert.throws(() => validatePreset(raw, BASE),
  err => err instanceof PresetError && pattern.test(err.message), String(pattern));

test('the shipped registry loads four presets plus the UT Austin background, all valid scenes', async () => {
  const { presets, background, errors } = await loadRegistry(`${ORIGIN}presets/index.json`, diskFetch);
  assert.deepEqual(errors, []);
  assert.deepEqual(presets.map(p => p.id), ['workshop', 'forest', 'japanese-garden', 'city', 'cyberpunk']);
  assert.equal(background?.id, 'ut-austin');
  for (const preset of [...presets, background]) {
    assert.ok(preset.name && preset.description, preset.id);
    assert.ok(preset.place.some(p => p.object), `${preset.id} has a landmark`);
    assert.ok(preset.scatter.length && preset.scatter.every(s => s.count[1] > 0), `${preset.id} scatters random props`);
    const scattered = new Set(preset.scatter.flatMap(s => s.objects));
    assert.ok(scattered.size >= 4, `${preset.id} draws its random props from a varied pool`);
  }
});

test('a broken or duplicate preset is skipped and reported, not fatal', async () => {
  const files = {
    'reg/index.json': JSON.stringify({ background: 'missing', presets: ['good', 'bad', 'dupe'] }),
    'reg/good/preset.json': JSON.stringify(minimal({ id: 'good' })),
    'reg/bad/preset.json': '{ not json',
    'reg/dupe/preset.json': JSON.stringify(minimal({ id: 'good', name: 'Copy' })),
  };
  const fetchFn = async url => {
    const body = files[String(url).slice(ORIGIN.length)];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, url: String(url), text: async () => body ?? '' };
  };
  const { presets, background, errors } = await loadRegistry(`${ORIGIN}reg/index.json`, fetchFn);
  assert.deepEqual(presets.map(p => p.name), ['Demo']);
  assert.equal(background, null);
  assert.equal(errors.length, 3);
  assert.match(errors.join('\n'), /bad: not valid JSON/);
  assert.match(errors.join('\n'), /duplicate id/);
  assert.match(errors.join('\n'), /missing: could not load/);
});

test('defaults are filled in and the result is normalized, not the input', () => {
  const raw = minimal({ tint: '#ABCDEF', place: [{ object: 'crate', pos: [0, 0, -5] }, { pos: [3, 0, 3], clear: 2 }] });
  const preset = validatePreset(raw, BASE);
  assert.equal(preset.tint, '#abcdef');
  assert.equal(preset.thumbnail, null, 'no thumbnail means the card shows a render');
  assert.deepEqual(preset.view, { yaw: 0, pitch: -4 });
  assert.deepEqual(preset.objects.crate[0].rot, [0, 0, 0]);
  assert.deepEqual(preset.place[0], { object: 'crate', pos: [0, 0, -5], yaw: 0, scale: 1, clear: 0 });
  assert.equal(preset.place[1].object, null, 'a place without an object only reserves space');
  assert.deepEqual(preset.scatter[0].scale, [1, 1]);
  assert.equal(preset.scatter[0].mode, 'ring');
  assert.equal(preset.environment.sun.intensity, 2);
  assert.notEqual(preset.objects.crate[0], raw.objects.crate[0]);
  assert.equal(validatePreset(minimal({ thumbnail: 'card.png' }), BASE).thumbnail, 'http://mirror.test/presets/demo/card.png');
  assert.equal(registryEntryUrl('forest', 'http://x/presets/index.json'), 'http://x/presets/forest/preset.json');
  assert.equal(registryEntryUrl('extra/my.json', 'http://x/presets/index.json'), 'http://x/presets/extra/my.json');
});

test('an imported file is held to the format: header, environment, parts and scatter rules', () => {
  rejects([], /JSON object/);
  rejects(minimal({ format: 'other' }), /"format"/);
  rejects(minimal({ version: 2 }), /newer Mirror Mirror/);
  for (const id of ['', 'Has Caps', 'trailing-', 'a/b', 'x'.repeat(41)]) rejects(minimal({ id }), /"id"/);
  rejects(minimal({ name: 'n'.repeat(41) }), /longer than/);
  rejects(minimal({ tint: 'red' }), /"tint"/);
  rejects(minimal({ environment: { ...minimal().environment, sky: ['#112233'] } }), /environment.sky/);
  rejects(minimal({ environment: { ...minimal().environment, fog: ['#445566', 40, 5] } }), /fog\[2\]/);
  rejects(minimal({ objects: {} }), /at least one object/);
  rejects(minimal({ objects: { Crate: [BOX] } }), /object name/);
  rejects(minimal({ objects: { crate: [{ ...BOX, shape: 'torus' }] } }), /shape/);
  rejects(minimal({ objects: { crate: [{ ...BOX, size: [1, 0, 1] }] } }), /size\[1\]/);
  rejects(minimal({ objects: { crate: [{ ...BOX, size: [1, LIMITS.size + 1, 1] }] } }), /size\[1\]/);
  rejects(minimal({ objects: { crate: [{ ...BOX, color: 'orange' }] } }), /color/);
  rejects(minimal({ objects: { crate: [{ ...BOX, emissive: '#fff' }] } }), /emissive/);
  rejects(minimal({ objects: { crate: [{ ...BOX, sides: 2 }] } }), /sides/);
  rejects(minimal({ objects: { crate: [{ ...BOX, pattern: { type: 'stripes' } }] } }), /pattern/);
  rejects(minimal({ objects: { crate: Array(LIMITS.parts + 1).fill(BOX) } }), /more than/);
  rejects(minimal({ place: [{ object: 'ghost', pos: [0, 0, 0] }] }), /not one of this preset's objects/);
  rejects(minimal({ place: [{ pos: [0, 0, 0] }] }), /needs an object or a clear radius/);
  rejects(minimal({ scatter: [{ objects: ['ghost'], count: [1, 2], radius: [1, 2] }] }), /not one of/);
  rejects(minimal({ scatter: [{ objects: ['crate'], count: [5, 2], radius: [1, 2] }] }), /min <= max/);
  rejects(minimal({ scatter: [{ objects: ['crate'], count: [1, 2], radius: [1, 2], mode: 'spiral' }] }), /mode/);
  rejects(minimal({ scatter: [{ objects: ['crate'], count: [0, LIMITS.scatterTotal], radius: [1, 2] },
    { objects: ['crate'], count: [0, 1], radius: [1, 2] }] }), /at most/);
});

test('only http(s), blob: and data:image URLs are allowed for a thumbnail', () => {
  for (const bad of ['javascript:alert(1)', 'file:///C:/secret.png', 'data:text/html,<script>', 'ftp://x/a.png']) {
    assert.throws(() => resolveImageUrl(bad, BASE), PresetError, bad);
    assert.throws(() => validatePreset(minimal({ thumbnail: bad }), BASE), PresetError, bad);
  }
  assert.equal(resolveImageUrl('https://cdn.test/a.png', BASE), 'https://cdn.test/a.png');
  assert.equal(resolveImageUrl('data:image/png;base64,iVBORw0', BASE), 'data:image/png;base64,iVBORw0');
  assert.match(resolveImageUrl('blob:http://mirror.test/1234', BASE), /^blob:/);
});

test('parsePreset reports bad JSON as a PresetError', () => {
  assert.throws(() => parsePreset('{"format":', BASE), err => err instanceof PresetError && /not valid JSON/.test(err.message));
  assert.equal(parsePreset(JSON.stringify(minimal()), BASE).id, 'demo');
});
