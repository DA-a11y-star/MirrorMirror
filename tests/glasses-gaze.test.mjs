import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALIBRATION_TARGETS, GazeInput, invertHomography, projectPoint } from '../web/gaze.js';
import { GazeUI } from '../web/gaze-ui.js';

const screen = [2, 0, -.5, 0, 2, -.5, 0, 0, 1]; // scene .25..75 -> screen 0..1
const features = (x, y) => [x, y, .1, .1];
const frame = (t, x, y, matrix = screen) => ({ t, gaze: {
  t, source: 'glasses', conf: .9, features: features(x, y), screen: matrix, sync_ms: 12,
} });

test('homography roundtrip handles perspective and rejects degenerate matrices', () => {
  const matrix = [2, .1, -.2, -.1, 3, -.3, .2, .1, 1];
  const point = [.35, .63];
  const roundtrip = projectPoint(invertHomography(matrix), projectPoint(matrix, point));
  assert.ok(Math.hypot(roundtrip[0] - point[0], roundtrip[1] - point[1]) < 1e-10);
  assert.equal(invertHomography(Array(9).fill(0)), null);
  assert.equal(projectPoint([1, 0, 0, 0, 1, 0, 0, 0, 0], point), null);
});

test('glasses gaze follows changing screen geometry and rejects missing references and blinks', () => {
  const input = new GazeInput('glasses');
  input.calibration.fit(CALIBRATION_TARGETS.map(target => {
    const sceneTarget = projectPoint(invertHomography(screen), target);
    return { target: sceneTarget, features: features(...sceneTarget) };
  }));
  input.ingest(frame(1, .5, .5), 100);
  assert.ok(Math.abs(input.get(100).x - .5) < .01);
  const movedScreen = [...screen];
  movedScreen[2] -= .2;
  input.ingest(frame(2, .5, .5, movedScreen), 200);
  assert.ok(Math.abs(input.get(200).x - .3) < .01, 'fixed eye direction moves on screen when head turns');
  input.ingest(frame(3, .5, .5, null), 300);
  assert.equal(input.get(300), null);
  input.ingest({ t: 4, gaze: { source: 'glasses', t: 4, conf: 0 } }, 400);
  assert.equal(input.get(400), null);
  assert.equal(input.learn({}), null, 'webcam grab adaptation must not alter glasses calibration');
});

test('glasses UI fits forward-image targets, validates in screen pixels, and never trains on validation', context => {
  let clock = 0;
  context.mock.method(performance, 'now', () => clock);
  const elements = new Map();
  globalThis.document = {
    fullscreenElement: {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, addEventListener() {}, classList: { toggle() {} } });
      return elements.get(id);
    },
    documentElement: { addEventListener() {} },
  };
  globalThis.window = { innerWidth: 1600, innerHeight: 1000, addEventListener() {} };
  try {
    const input = new GazeInput('glasses');
    const ui = new GazeUI(input, () => {});
    let t = 0;
    function complete(mode, offset = 0) {
      ui.start(mode);
      let count = 0;
      while (input.calibrating) {
        assert.ok(++count <= 9);
        const start = ui.startedAt;
        const sceneTarget = projectPoint(invertHomography(screen), ui.targets[ui.index]);
        for (let i = 0; i < 10; i++) {
          clock = start + 610 + i * 100;
          input.ingest(frame(++t, sceneTarget[0] + offset, sceneTarget[1]), clock);
          ui.observe(clock);
        }
      }
    }
    complete('calibration');
    assert.ok(input.calibration.model);
    const model = structuredClone(input.calibration.model);
    complete('validation');
    assert.ok(ui.dataset.validation[0].summary.meanPx < 10, 'unbiased held-out predictions are scored in screen space');
    complete('validation', .05);
    assert.deepEqual(input.calibration.model, model);
    const summary = ui.dataset.validation[1].summary;
    assert.ok(summary.meanPx > 140 && summary.meanPx < 180, `expected ~160 px, got ${summary.meanPx}`);
    assert.equal(input.get(clock), null);
    document.fullscreenElement = null;
    ui.start();
    assert.equal(input.calibrating, true, 'browser markers map a windowed viewport too');
    ui.cancel();
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});
