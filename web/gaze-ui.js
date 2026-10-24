import { CALIBRATION_TARGETS, median } from './gaze.js';

export class GazeUI {
  constructor(input, onModeChange) {
    this.input = input;
    this.onModeChange = onModeChange;
    this.source = document.getElementById('gaze-source');
    this.button = document.getElementById('calibrate');
    this.overlay = document.getElementById('calibration');
    this.dot = document.getElementById('calibration-dot');
    this.instruction = document.getElementById('calibration-instruction');
    this.status = document.getElementById('gaze-status');
    this.reticle = document.getElementById('gaze-reticle');
    this.source.value = input.source;
    this.source.addEventListener('change', () => {
      this.message = null;
      this.cancel();
      input.setSource(this.source.value);
      this.button.disabled = input.source !== 'webcam';
      onModeChange();
    });
    this.button.disabled = input.source !== 'webcam';
    this.button.addEventListener('click', () => this.start());
    document.getElementById('cancel-calibration').addEventListener('click', () => this.cancel());
    window.addEventListener('keydown', e => { if (e.key === 'Escape') this.cancel(); });
    window.addEventListener('pointermove', e => {
      input.pointer = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight, conf: 1 };
    });
    document.documentElement.addEventListener('pointerleave', () => { input.pointer = null; });
    window.addEventListener('resize', () => {
      this.cancel();
      input.calibration.clear();
      input.output = null;
      input.status = 'window resized: recalibrate webcam gaze';
      onModeChange();
    });
  }

  start() {
    this.message = null;
    this.input.calibrating = true;
    this.input.calibration.clear();
    this.input.output = null;
    this.samples = [];
    this.index = 0;
    this.overlay.hidden = false;
    this.onModeChange();
    this.nextTarget();
  }

  nextTarget() {
    const [x, y] = CALIBRATION_TARGETS[this.index];
    this.dot.style.left = `${x * 100}%`;
    this.dot.style.top = `${y * 100}%`;
    this.startedAt = performance.now();
    this.lastSampleTime = null;
    this.targetSamples = [];
  }

  cancel() {
    this.input.calibrating = false;
    this.overlay.hidden = true;
  }

  observe(now) {
    if (!this.input.calibrating) return;
    const raw = this.input.raw;
    const elapsed = now - this.startedAt;
    const valid = raw?.features && now - this.input.lastReceived < 250;
    this.instruction.textContent = valid
      ? `Look at the dot · ${this.index + 1} / 9 · ${elapsed < 600 ? 'settle your eyes' : 'keep looking…'}`
      : `Look at the dot · ${this.index + 1} / 9 · face the camera with eyes open`;
    // Ignore the saccade after a target moves; collect distinct observations, not repeated hand frames.
    if (!valid || elapsed < 600 || raw.t === this.lastSampleTime) return;
    this.lastSampleTime = raw.t;
    this.targetSamples.push(raw.features);
    if (elapsed < 1500 || this.targetSamples.length < 10) return;
    const features = Array.from({ length: 4 }, (_, i) => median(this.targetSamples.map(sample => sample[i])));
    this.samples.push({ features, target: CALIBRATION_TARGETS[this.index] });
    if (++this.index < CALIBRATION_TARGETS.length) {
      this.nextTarget();
      return;
    }
    try {
      this.input.calibration.fit(this.samples);
      this.input.status = 'calibrated · look at a block, then pinch';
    } catch (error) {
      this.input.status = error.message;
      this.message = error.message;
    }
    this.cancel();
  }

  update(now, target, holding) {
    const point = this.input.get(now);
    this.reticle.hidden = !point;
    if (point) {
      this.reticle.style.left = `${point.x * 100}%`;
      this.reticle.style.top = `${point.y * 100}%`;
      this.reticle.classList.toggle('on-target', !!target);
    }
    const status = this.message || this.input.status;
    const refined = now - this.input.refinedAt < 1500 ? ' · gaze refined' : '';
    this.status.textContent = `${status}${holding ? ` · holding ${holding}` : target ? ` · target ${target}` : ''}${refined}`;
  }
}
