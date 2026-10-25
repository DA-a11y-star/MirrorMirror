import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKER_BITS, markerLayout } from '../web/screen-markers.js';
import { GazeInput, CALIBRATION_TARGETS } from '../web/gaze.js';

test('browser marker layout uses real viewport geometry on wide, tall, and high-resolution screens', () => {
  for (const [width, height] of [[1280, 800], [1920, 1080], [800, 1200], [3024, 1964], [160, 160]]) {
    const layout = markerLayout(width, height);
    assert.deepEqual(layout.markers.map(m => m.id), [10, 11, 12, 13]);
    for (const { corners } of layout.markers) {
      assert.ok(corners.flat().every(v => v > 0 && v < 1));
      assert.ok(Math.abs((corners[1][0] - corners[0][0]) * width - layout.size) < 1e-8);
      assert.ok(Math.abs((corners[2][1] - corners[1][1]) * height - layout.size) < 1e-8);
    }
    assert.equal(layout.size % 6, 0, 'modules render at integer CSS-pixel sizes');
    assert.ok(layout.markers[0].corners[1][0] < layout.markers[1].corners[0][0]);
    assert.ok(layout.markers[0].corners[2][1] < layout.markers[3].corners[0][1]);
  }
  assert.equal(markerLayout(0, 800), null);
  assert.equal(markerLayout(Infinity, 800), null);
  assert.ok(MARKER_BITS.every(rows => rows.length === 6 && rows.every(row => /^[01]{6}$/.test(row))));
});

test('a browser resize invalidates calibration and old layout packets cannot restore it', () => {
  const input = new GazeInput('glasses');
  input.setScreenLayout('first');
  input.calibration.fit(CALIBRATION_TARGETS.map(target => ({ target, features: [...target, 0, 0] })));
  const gaze = { source: 'glasses', screen_layout: 'first', conf: .9, features: [.5, .5, 0, 0],
    screen: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: 1 };
  input.ingest({ gaze }, 100);
  assert.ok(input.get(100));
  input.setScreenLayout('second');
  assert.equal(input.calibration.model, null);
  input.ingest({ gaze: { ...gaze, t: 2 } }, 200);
  assert.equal(input.raw, null);
  assert.equal(input.get(200), null);
  input.ingest({ gaze: { ...gaze, screen_layout: 'second', t: 3 } }, 300);
  assert.ok(input.raw, 'new layout data is available for recalibration');
  assert.equal(input.get(300), null, 'new geometry still needs calibration');
});
