import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePreset, PRESET_FORMAT } from '../web/presets.js';
import { random, scatterLayout } from '../web/set-layout.js';

const BOX = { shape: 'box', size: [1, 1, 1], pos: [0, .5, 0], color: '#e76f51' };
const preset = (scatter, place = []) => validatePreset({
  format: PRESET_FORMAT, version: 1, id: 'test', name: 'Test',
  environment: { sky: ['#112233', '#445566'], fog: ['#445566', 5, 40], ground: '#336633' },
  objects: { a: [BOX], b: [BOX], c: [BOX], tower: [BOX] }, place, scatter,
}, 'http://mirror.test/p.json');
const props = layout => layout.filter(item => !item.landmark);

test('random() is deterministic per seed and stays in [0, 1)', () => {
  const a = random(42);
  const b = random(42);
  const values = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(values.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.ok(values.every(v => v >= 0 && v < 1));
  assert.notDeepEqual(values.slice(0, 5), Array.from({ length: 5 }, random(43)));
});

test('the same seed repeats a layout; another seed changes what is added and where', () => {
  const p = preset([{ objects: ['a', 'b', 'c'], count: [10, 20], radius: [3, 30] }]);
  assert.deepEqual(scatterLayout(p, random(1)), scatterLayout(p, random(1)));
  const first = scatterLayout(p, random(1));
  const second = scatterLayout(p, random(2));
  assert.notDeepEqual(first.map(i => [i.object, i.x]), second.map(i => [i.object, i.x]));
  assert.deepEqual(new Set(first.map(i => i.object)), new Set(['a', 'b', 'c']), 'draws from the whole pool');
});

test('ring scatter: count within range, inside the ring, spaced apart, scale within range', () => {
  const p = preset([{ objects: ['a'], count: [12, 18], radius: [4, 25], spacing: 3, scale: [.8, 1.4], stretch: [1, 2] }]);
  for (let seed = 0; seed < 20; seed++) {
    const items = props(scatterLayout(p, random(seed)));
    assert.ok(items.length >= 12 && items.length <= 18, `count ${items.length}`);
    for (const [i, item] of items.entries()) {
      const r = Math.hypot(item.x, item.z);
      assert.ok(r >= 4 - 1e-9 && r <= 25 + 1e-9, `radius ${r}`);
      assert.ok(item.scale >= .8 && item.scale <= 1.4 && item.stretch >= 1 && item.stretch <= 2);
      for (const other of items.slice(i + 1)) assert.ok(Math.hypot(item.x - other.x, item.z - other.z) >= 3 - 1e-9, 'spacing');
    }
  }
});

test('landmarks are kept as given, and clear zones and road margins keep scattered props away', () => {
  const p = preset([{ objects: ['a'], count: [40, 40], radius: [2, 30], spacing: .5, keepOffRoads: 3 }],
    [{ object: 'tower', pos: [0, 0, -12], yaw: 30, scale: 2, clear: 6 }, { pos: [10, 0, 10], clear: 5 }]);
  for (let seed = 0; seed < 10; seed++) {
    const layout = scatterLayout(p, random(seed));
    assert.deepEqual(layout[0], { object: 'tower', x: 0, y: 0, z: -12, yaw: 30, scale: 2, stretch: 1, landmark: true });
    for (const item of props(layout)) {
      assert.ok(Math.hypot(item.x, item.z + 12) >= 6, 'outside the landmark clear zone');
      assert.ok(Math.hypot(item.x - 10, item.z - 10) >= 5, 'outside the reserved zone');
      assert.ok(Math.abs(item.x) >= 3 && Math.abs(item.z) >= 3, 'off the roads');
    }
  }
});

test('road scatter puts props in a lane of one of the two crossing roads, facing along it', () => {
  const p = preset([{ objects: ['a'], count: [10, 10], radius: [8, 50], mode: 'roads', width: 8, spacing: 4 }]);
  const items = props(scatterLayout(p, random(7)));
  assert.equal(items.length, 10);
  for (const item of items) {
    const onX = Math.abs(item.z) === 2;
    const onZ = Math.abs(item.x) === 2;
    assert.ok(onX || onZ, `in a lane: ${item.x}, ${item.z}`);
    const along = onX ? Math.abs(item.x) : Math.abs(item.z);
    assert.ok(along >= 8 && along <= 50);
    assert.ok(onX ? [0, 180].includes(item.yaw) : [90, -90].includes(item.yaw), `faces along the road: ${item.yaw}`);
  }
});

test('snap rounds the facing and y lifts props, e.g. onto a deck', () => {
  const p = preset([{ objects: ['a'], count: [15, 15], radius: [2, 20], snap: 90, y: .3, spacing: .5 }]);
  for (const item of props(scatterLayout(p, random(3)))) {
    assert.equal(item.yaw % 90, 0);
    assert.equal(item.y, .3);
  }
});
