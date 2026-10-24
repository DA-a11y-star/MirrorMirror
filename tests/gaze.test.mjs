import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALIBRATION_TARGETS, GazeCalibration, GazeInput } from '../web/gaze.js';

const features = (x, y) => [.15 * (x - .5), .08 * (y - .5), .03, .4];
const samples = () => CALIBRATION_TARGETS.map(target => ({ target, features: features(...target) }));
const webcamFrame = (t, x = .5, y = .5) => ({ t, gaze: { t, source: 'webcam', conf: .8, features: features(x, y) } });

test('calibration generalizes to untrained gaze positions', () => {
  const model = new GazeCalibration();
  assert.ok(model.fit(samples()) < .02);
  const point = model.predict(features(.7, .4));
  assert.ok(Math.abs(point[0] - .7) < .01);
  assert.ok(Math.abs(point[1] - .4) < .01);
});

test('stationary eyes cannot produce a successful calibration', () => {
  const model = new GazeCalibration();
  assert.throws(() => model.fit(samples().map(s => ({ ...s, features: [0, 0, .03, .4] }))), /too small/);
  assert.equal(model.model, null);
  assert.throws(() => model.fit(samples().slice(0, 8)), /nine valid/);
});

test('inconsistent calibration is rejected instead of enabling bad targeting', () => {
  const bad = samples();
  [bad[1].features, bad[5].features] = [bad[5].features, bad[1].features];
  assert.throws(() => new GazeCalibration().fit(bad), /inconsistent/);
});

test('uncalibrated webcam never creates a fake center gaze; calibration enables it', () => {
  const input = new GazeInput('webcam');
  input.ingest(webcamFrame(1), 100);
  assert.equal(input.get(100), null);
  input.calibration.fit(samples());
  input.ingest(webcamFrame(2, .7, .4), 200);
  assert.ok(Math.abs(input.get(200).x - .7) < .01);
  input.calibrating = true;
  assert.equal(input.get(200), null);
});

test('replayed gaze timestamps do not extend freshness; blinking clears targeting', () => {
  const input = new GazeInput('webcam');
  input.calibration.fit(samples());
  input.ingest(webcamFrame(1), 0);
  input.ingest(webcamFrame(1), 300);
  assert.equal(input.get(400), null);
  input.ingest(webcamFrame(2), 500);
  assert.ok(input.get(500));
  input.ingest({ t: 3, gaze: { source: 'webcam', conf: 0, t: 3 } }, 550);
  assert.equal(input.get(550), null);
});

// Stream steady webcam gaze for a while, as the tracker would between a look and a pinch.
function watch(input, x, y, from = 1000, frames = 8) {
  for (let i = 0; i < frames; i++) input.ingest(webcamFrame(from + i, x, y), from + i * 50);
}
const aimAt = (x, y) => ({ x0: x, x1: x, y0: y, y1: y });
const error = (input, now, x, y) => Math.hypot(input.get(now).x - x, input.get(now).y - y);

test('confirmed grabs pull a drifted estimate back toward the block the user looked at', () => {
  const input = new GazeInput('webcam');
  input.calibration.fit(samples());
  // The head has moved: looking at (.55, .45) now reads as (.65, .39).
  watch(input, .65, .39);
  const now = 1500;
  assert.ok(Math.abs(error(input, 1350, .55, .45) - Math.hypot(.1, .06)) < .01);
  const misses = [];
  for (let i = 0; i < 3; i++) misses.push(input.learn({ rect: aimAt(.55, .45), at: now, now, aspect: 1 }));
  assert.ok(misses[0] > misses[1] && misses[1] > misses[2], `each grab shrinks the miss: ${misses}`);
  input.ingest(webcamFrame(2000, .65, .39), 2000);
  assert.ok(error(input, 2000, .55, .45) < .02, 'three grabs recover most of the drift');
  assert.equal(input.refinedAt, now);
});

test('an estimate that already lands inside the block needs no correction', () => {
  const input = new GazeInput('webcam');
  input.calibration.fit(samples());
  watch(input, .52, .5);
  const miss = input.learn({ rect: { x0: .45, x1: .6, y0: .4, y1: .6 }, at: 1500, now: 1500, aspect: 1 });
  assert.equal(miss, 0);
  assert.deepEqual(input.calibration.bias, [0, 0]);
});

test('implausible or unsupported grabs never move the calibration', () => {
  const input = new GazeInput('webcam');
  input.calibration.fit(samples());
  watch(input, .2, .2);
  assert.equal(input.learn({ rect: aimAt(.8, .8), at: 1500, now: 1500, aspect: 1 }), null, 'looking far from the block');
  assert.equal(input.learn({ rect: aimAt(.2, .2), at: 5000, now: 5000, aspect: 1 }), null, 'no recent gaze to learn from');
  assert.deepEqual(input.calibration.bias, [0, 0]);

  const uncalibrated = new GazeInput('webcam');
  watch(uncalibrated, .5, .5);
  assert.equal(uncalibrated.learn({ rect: aimAt(.6, .6), at: 1500, now: 1500, aspect: 1 }), null);

  for (const source of ['external', 'pointer']) {
    const other = new GazeInput(source);
    assert.equal(other.learn({ rect: aimAt(.6, .6), at: 1500, now: 1500, aspect: 1 }), null);
  }
});

test('recalibrating, resizing or switching source discards the learned correction', () => {
  const input = new GazeInput('webcam');
  input.calibration.fit(samples());
  watch(input, .65, .39);
  input.learn({ rect: aimAt(.55, .45), at: 1500, now: 1500, aspect: 1 });
  assert.notDeepEqual(input.calibration.bias, [0, 0]);
  input.calibration.fit(samples());
  assert.deepEqual(input.calibration.bias, [0, 0]);

  input.learn({ rect: aimAt(.55, .45), at: 1500, now: 1500, aspect: 1 });
  assert.notDeepEqual(input.calibration.bias, [0, 0]);
  input.calibration.clear();
  assert.deepEqual(input.calibration.bias, [0, 0]);
  assert.equal(input.calibration.model, null);

  input.setSource('external');
  input.setSource('webcam');
  assert.equal(input.history.length, 0);
});

test('external gaze bypasses webcam calibration with the same output interface', () => {
  const input = new GazeInput('external');
  input.ingest({ t: 1, gaze: { x: .25, y: .75, conf: 1, source: 'device' } }, 100);
  assert.deepEqual(input.get(100), { x: .25, y: .75, conf: 1 });
  input.setSource('pointer');
  input.pointer = { x: .6, y: .3, conf: 1 };
  assert.deepEqual(input.get(1000), input.pointer);
  input.setSource('external');
  assert.equal(input.get(1000), null);
  input.ingest({ t: 0, gaze: { x: .5, y: .5, conf: 1 } }, 1100);
  assert.ok(input.get(1100));
  input.reset();
  assert.equal(input.get(1100), null);
});
