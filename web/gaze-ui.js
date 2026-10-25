import { CALIBRATION_TARGETS, median } from './gaze.js';
import { VALIDATION_TARGETS, recordGaze, summarizeValidation } from './gaze-validation.js';

export class GazeUI {
  constructor(input, onModeChange) {
    this.input = input;
    this.onModeChange = onModeChange;
    this.source = document.getElementById('gaze-source');
    this.button = document.getElementById('calibrate');
    this.validateButton = document.getElementById('validate-gaze');
    this.result = document.getElementById('gaze-result');
    this.dataset = { calibration: null, validation: [] };
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
      this.button.disabled = !['webcam', 'glasses'].includes(input.source);
      onModeChange();
    });
    this.button.disabled = !['webcam', 'glasses'].includes(input.source);
    this.button.addEventListener('click', () => this.start('calibration'));
    this.validateButton.addEventListener('click', () => this.start('validation'));
    document.getElementById('fullscreen-gaze').addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (error) {
        this.message = `Could not change fullscreen mode: ${error.message}`;
      }
    });
    document.getElementById('export-gaze').addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(this.dataset, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `gaze-${input.source}-${Date.now()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
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
      input.status = `window resized: recalibrate ${input.source} gaze`;
      onModeChange();
    });
    document.documentElement.addEventListener('fullscreenchange', () => {
      if (input.source === 'glasses') {
        this.cancel();
        input.calibration.clear();
        input.reset();
        this.message = null;
        input.status = 'Display mode changed: recalibrate glasses gaze.';
        onModeChange();
      }
    });
  }

  start(mode = 'calibration') {
    if (!['webcam', 'glasses'].includes(this.input.source)) return;
    if (mode === 'validation' && !this.input.calibration.model) return;
    this.mode = mode;
    this.targets = mode === 'validation' ? VALIDATION_TARGETS : CALIBRATION_TARGETS;
    this.message = null;
    this.input.calibrating = true;
    if (mode === 'calibration') this.input.calibration.clear();
    this.input.output = null;
    this.samples = [];
    this.index = 0;
    this.session = { source: this.input.source, samples: [], viewport: {
      width: window.innerWidth, height: window.innerHeight,
    } };
    this.overlay.hidden = false;
    this.onModeChange();
    this.nextTarget();
  }

  nextTarget() {
    const [x, y] = this.targets[this.index];
    this.dot.style.left = `${x * 100}%`;
    this.dot.style.top = `${y * 100}%`;
    this.startedAt = performance.now();
    this.lastSampleTime = null;
    this.targetSamples = [];
  }

  cancel() {
    this.input.calibrating = false;
    this.input.output = this.input.raw = null;
    this.overlay.hidden = true;
  }

  observe(now) {
    if (!this.input.calibrating) return;
    const raw = this.input.raw;
    const elapsed = now - this.startedAt;
    const valid = raw?.features && now - this.input.lastReceived < 250;
    this.instruction.textContent = valid
      ? `Look at the dot · ${this.index + 1} / ${this.targets.length} · ${elapsed < 600 ? 'settle your eyes' : 'keep looking…'}`
      : `Waiting for eye/screen data · ${this.input.status}`;
    // Ignore the saccade after a target moves; collect distinct observations, not repeated hand frames.
    if (!valid || elapsed < 600 || raw.t === this.lastSampleTime) return;
    this.lastSampleTime = raw.t;
    const target = this.targets[this.index];
    const mappedTarget = this.input.calibrationTarget(target, raw);
    if (!mappedTarget) return;
    const record = recordGaze(this.input, target, now);
    if (this.mode === 'validation' && !record.prediction) return;
    this.session.samples.push(record);
    this.targetSamples.push({ features: [...raw.features], target: mappedTarget });
    if (elapsed < 1500 || this.targetSamples.length < 10) return;
    const features = Array.from({ length: 4 }, (_, i) => median(this.targetSamples.map(sample => sample.features[i])));
    const fittedTarget = [0, 1].map(i => median(this.targetSamples.map(sample => sample.target[i])));
    this.samples.push({ features, target: fittedTarget });
    if (++this.index < this.targets.length) {
      this.nextTarget();
      return;
    }
    try {
      if (this.mode === 'calibration') {
        this.input.calibration.fit(this.samples);
        this.dataset.calibration = this.session;
        this.dataset.validation = [];
        this.result.textContent = 'Calibrated. Run Validate accuracy to measure held-out error.';
        this.input.status = 'calibrated · look at a block, then pinch';
      } else {
        const summary = summarizeValidation(this.session.samples, this.session.viewport);
        this.session.summary = summary;
        this.dataset.validation.push(this.session);
        this.result.textContent = `Held-out error: mean ${summary.meanPx.toFixed(0)} px · p90 ${summary.p90Px.toFixed(0)} px`;
        this.input.status = 'validation complete';
      }
    } catch (error) {
      this.input.status = error.message;
      this.message = error.message;
    }
    this.cancel();
  }

  update(now, target, holding) {
    this.validateButton.disabled = !['webcam', 'glasses'].includes(this.input.source) || !this.input.calibration.model;
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
