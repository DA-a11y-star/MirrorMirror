import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALIBRATION_TARGETS, GazeInput } from '../web/gaze.js';
import { GazeUI } from '../web/gaze-ui.js';
import { VALIDATION_TARGETS, summarizeValidation } from '../web/gaze-validation.js';

const features = (x, y) => [.15 * (x - .5), .08 * (y - .5), .03, .4];

test('held-out error uses pixel aspect ratio, nearest-rank p90, and unclipped predictions', () => {
  assert.ok(VALIDATION_TARGETS.every(p => !CALIBRATION_TARGETS.some(c => c[0] === p[0] && c[1] === p[1])));
  const samples = Array.from({ length: 10 }, (_, i) => ({ target: [1, .5], prediction: [1 + (i + 1) / 10, .5] }));
  const result = summarizeValidation(samples, { width: 2000, height: 1000 });
  assert.ok(Math.abs(result.meanPx - 1100) < 1e-9);
  assert.ok(Math.abs(result.p90Px - 1800) < 1e-9);
  assert.ok(Math.abs(result.p90ScreenHeights - 1.8) < 1e-9);
  assert.throws(() => summarizeValidation([], { width: 2000, height: 1000 }), /No validation/);
});

test('UI records calibration and held-out frames without training on validation or repeated frames', context => {
  let clock = 0;
  context.mock.method(performance, 'now', () => clock);
  const elements = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, addEventListener() {}, classList: { toggle() {} } });
      return elements.get(id);
    },
    documentElement: { addEventListener() {} },
  };
  globalThis.window = { innerWidth: 1600, innerHeight: 1000, devicePixelRatio: 2, addEventListener() {} };
  try {
    const input = new GazeInput();
    const ui = new GazeUI(input, () => {});
    let t = 0;
    function complete(mode, dx = 0) {
      ui.start(mode);
      let targets = 0;
      while (input.calibrating) {
        assert.ok(++targets <= 9, 'session must finish after its targets');
        const target = ui.targets[ui.index];
        const start = ui.startedAt;
        for (let i = 0; i < 10; i++) {
          const now = start + 610 + i * 100;
          clock = now;
          const head = { pos: [.01, .02, .55], quat: [0, 0, 0, 1] };
          input.ingest({ t: ++t, head, gaze: { t, source: 'webcam', conf: .8, features: features(target[0] + dx, target[1]) } }, now);
          ui.observe(now);
          ui.observe(now); // a repeated hand frame must not count twice
          head.pos[0] = 99; // exported head data must be an immutable snapshot
        }
      }
    }
    complete('calibration');
    assert.equal(ui.dataset.calibration.samples.length, 90);
    assert.equal(ui.dataset.calibration.samples[0].head.pos[0], .01);
    const model = structuredClone(input.calibration.model);
    complete('validation', .1);
    assert.deepEqual(input.calibration.model, model);
    assert.deepEqual(input.calibration.bias, [0, 0]);
    assert.equal(ui.dataset.validation[0].samples.length, 50);
    assert.ok(ui.dataset.validation[0].summary.meanPx > 140, 'a real held-out bias must be visible');
    assert.match(ui.result.textContent, /p90/);
    assert.equal(input.get(performance.now()), null, 'no overlay gaze leaks back into interaction');
    ui.start('validation');
    ui.cancel();
    assert.equal(ui.dataset.validation.length, 1, 'a cancelled run is not reported as complete');
    assert.deepEqual(input.calibration.model, model);
    input.setSource('pointer');
    ui.update(performance.now());
    assert.equal(ui.validateButton.disabled, true);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});
