// Source-independent normalized viewport gaze. Only webcam input needs our iris-feature calibration.
export const CALIBRATION_TARGETS = [
  [.5, .5], [.15, .15], [.5, .15], [.85, .15], [.85, .5],
  [.85, .85], [.5, .85], [.15, .85], [.15, .5],
];
const FEATURE_COUNT = 4;
const MIN_CONFIDENCE = .5;
const MAX_AGE_MS = 350;
// Self-correction from confirmed grabs. Head drift mostly shifts the whole estimate, so each grab nudges an offset.
const ADAPT_RATE = .5;      // fraction of the miss corrected per confirmed grab
const MAX_ADAPT_MISS = .25; // in screen heights; a bigger miss means the user probably wasn't looking at the block
const MAX_BIAS = .25;       // the offset can never wander further than this in normalized viewport units
const HISTORY_MS = 2000;
// Iris features from this window before a pinch describe the gaze that chose the block: it ends early to skip
// the glance toward the hand, and the tracker pipeline adds delay.
const LEARN_WINDOW_MS = [550, 150];

export const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function solve(matrix, values) {
  const rows = matrix.map((row, i) => [...row, values[i]]);
  for (let i = 0; i < rows.length; i++) {
    let pivot = i;
    for (let j = i + 1; j < rows.length; j++) if (Math.abs(rows[j][i]) > Math.abs(rows[pivot][i])) pivot = j;
    [rows[i], rows[pivot]] = [rows[pivot], rows[i]];
    const scale = rows[i][i];
    if (Math.abs(scale) < 1e-10) throw new Error('Calibration has too little eye movement. Try again.');
    for (let k = i; k <= rows.length; k++) rows[i][k] /= scale;
    for (let j = 0; j < rows.length; j++) {
      if (j === i) continue;
      const factor = rows[j][i];
      for (let k = i; k <= rows.length; k++) rows[j][k] -= factor * rows[i][k];
    }
  }
  return rows.map(row => row.at(-1));
}

function regression(samples) {
  const means = Array.from({ length: FEATURE_COUNT }, (_, i) => samples.reduce((sum, s) => sum + s.features[i], 0) / samples.length);
  const scales = means.map((mean, i) => Math.max(i < 2 ? .003 : .02,
    Math.sqrt(samples.reduce((sum, s) => sum + (s.features[i] - mean) ** 2, 0) / samples.length)));
  const rows = samples.map(s => [1, ...s.features.map((v, i) => (v - means[i]) / scales[i])]);
  const matrix = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) =>
    rows.reduce((sum, row) => sum + row[i] * row[j], 0) + (i === j && i > 0 ? .12 : 0)));
  const weights = [0, 1].map(axis => solve(matrix,
    Array.from({ length: 5 }, (_, i) => rows.reduce((sum, row, n) => sum + row[i] * samples[n].target[axis], 0))));
  return { means, scales, weights };
}

function predict(model, features) {
  const row = [1, ...features.map((v, i) => (v - model.means[i]) / model.scales[i])];
  return model.weights.map(weights => row.reduce((sum, v, i) => sum + v * weights[i], 0));
}

export class GazeCalibration {
  constructor() {
    this.model = null;
    this.bias = [0, 0];
  }

  clear() {
    this.model = null;
    this.bias = [0, 0];
  }

  fit(samples) {
    this.clear();
    if (samples.length !== CALIBRATION_TARGETS.length || samples.some(s =>
      !Array.isArray(s.features) || s.features.length !== FEATURE_COUNT || !s.features.every(Number.isFinite) ||
      !Array.isArray(s.target) || s.target.length !== 2 || !s.target.every(Number.isFinite))) {
      throw new Error('Calibration needs nine valid target samples.');
    }
    // Stationary eyes must not appear to calibrate just because the head moved.
    for (let i = 0; i < 2; i++) {
      const values = samples.map(s => s.features[i]);
      if (Math.max(...values) - Math.min(...values) < .008) {
        throw new Error('Eye movement was too small. Look at each dot, keeping your head comfortably still.');
      }
    }
    // Leave-one-target-out error catches a fit that only memorizes calibration dots.
    const errors = samples.map((sample, i) => {
      const model = regression(samples.filter((_, j) => j !== i));
      const p = predict(model, sample.features);
      return (p[0] - sample.target[0]) ** 2 + (p[1] - sample.target[1]) ** 2;
    });
    this.error = Math.sqrt(errors.reduce((sum, e) => sum + e, 0) / errors.length);
    if (!Number.isFinite(this.error) || this.error > .18) {
      throw new Error('Calibration was inconsistent. Improve lighting, face the camera and try again.');
    }
    this.model = regression(samples);
    return this.error;
  }

  predict(features) {
    if (!this.model) return null;
    const point = predict(this.model, features);
    return [point[0] + this.bias[0], point[1] + this.bias[1]];
  }

  // The user held a grab on a block, so they were looking inside `rect` (normalized viewport coordinates).
  // Move the offset part of the way toward putting this estimate inside it. Returns the miss in screen heights
  // (0 when the estimate already landed inside), or null if the sample was rejected as implausible.
  adapt(features, rect, aspect = 1) {
    const estimate = this.predict(features);
    if (!estimate) return null;
    const dx = clamp(estimate[0], rect.x0, rect.x1) - estimate[0];
    const dy = clamp(estimate[1], rect.y0, rect.y1) - estimate[1];
    const miss = Math.hypot(dx * aspect, dy);
    if (!Number.isFinite(miss) || miss > MAX_ADAPT_MISS) return null;
    this.bias = [clamp(this.bias[0] + ADAPT_RATE * dx, -MAX_BIAS, MAX_BIAS),
      clamp(this.bias[1] + ADAPT_RATE * dy, -MAX_BIAS, MAX_BIAS)];
    return miss;
  }
}

export class GazeInput {
  constructor(source = 'webcam') {
    this.calibration = new GazeCalibration();
    this.pointer = null;
    this.calibrating = false;
    this.refinedAt = -Infinity;
    this.setSource(source);
  }

  setSource(source) {
    if (!['webcam', 'external', 'pointer'].includes(source)) throw new Error(`Unknown gaze source: ${source}`);
    this.source = source;
    this.reset();
    this.status = source === 'webcam' ? 'calibrate webcam gaze' : `waiting for ${source} gaze`;
  }

  reset() {
    this.raw = this.output = this.head = null;
    this.lastTimestamp = null;
    this.lastReceived = -Infinity;
    this.history = [];
  }

  // A confirmed grab on a block: refine the webcam calibration from the iris features that chose it.
  learn({ rect, at, now, aspect }) {
    if (this.source !== 'webcam' || !this.calibration.model) return null;
    const [oldest, newest] = LEARN_WINDOW_MS;
    const recent = this.history.filter(s => s.at >= at - oldest && s.at <= at - newest);
    if (recent.length < 4) return null;
    const features = Array.from({ length: FEATURE_COUNT }, (_, i) => median(recent.map(s => s.features[i])));
    const miss = this.calibration.adapt(features, rect, aspect);
    if (miss) this.refinedAt = now; // only a real correction counts, not a hit that was already inside the block
    return miss;
  }

  ingest(frame, now) {
    if (this.source === 'pointer') return;
    const gaze = frame.gaze;
    const t = gaze?.t ?? frame.t;
    if (!gaze || !Number.isFinite(gaze.conf) || gaze.conf < MIN_CONFIDENCE || !Number.isFinite(t)) {
      this.raw = this.output = null;
      this.status = gaze?.status || 'gaze unavailable';
      return;
    }
    if (this.lastTimestamp !== null && t <= this.lastTimestamp) return;
    const dt = this.lastTimestamp === null ? 1 : Math.min(t - this.lastTimestamp, .25);
    this.lastTimestamp = t;
    this.lastReceived = now;
    this.raw = gaze;
    this.head = frame.head ?? null; // kept so validation runs can snapshot head pose beside each gaze sample
    let point;
    if (this.source === 'webcam') {
      if (gaze.source !== 'webcam' || !Array.isArray(gaze.features) || gaze.features.length !== FEATURE_COUNT || !gaze.features.every(Number.isFinite)) {
        this.raw = this.output = null;
        this.status = 'webcam iris data unavailable';
        return;
      }
      this.history.push({ at: now, features: gaze.features });
      while (now - this.history[0].at > HISTORY_MS) this.history.shift();
      point = this.calibration.predict(gaze.features);
      this.status = point ? 'webcam gaze calibrated' : 'calibrate webcam gaze';
    } else {
      point = [gaze.x, gaze.y];
      this.status = 'external tracker gaze';
    }
    if (!point || !point.every(Number.isFinite) || point.some(v => v < -.15 || v > 1.15)) {
      this.output = null;
      return;
    }
    const [x, y] = point.map(v => Math.max(0, Math.min(1, v)));
    const k = 1 - Math.exp(-12 * dt);
    this.output = this.output ? { x: this.output.x + (x - this.output.x) * k, y: this.output.y + (y - this.output.y) * k, conf: gaze.conf }
      : { x, y, conf: gaze.conf };
  }

  get(now) {
    if (this.calibrating) return null;
    if (this.source === 'pointer') return this.pointer;
    if (now - this.lastReceived > MAX_AGE_MS) return null;
    return this.output;
  }
}
