import { CALIBRATION_TARGETS, median } from './gaze.js';
import { VALIDATION_TARGETS, recordGaze, summarizeValidation } from './gaze-validation.js';

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
    this.validateButton = document.getElementById('validate');
    this.result = document.getElementById('gaze-result');
    this.mode = 'calibration';
    this.targets = CALIBRATION_TARGETS;
    this.index = 0;
    this.dataset = { calibration: { samples: [] }, validation: [] };
    this.source.value = input.source;
    this.source.addEventListener('change', () => {
      this.message = null;
      this.cancel();
      input.setSource(this.source.value);
      this.button.disabled = input.source !== 'webcam';
      onModeChange();
    });
    this.button.disabled = input.source !== 'webcam';
    this.validateButton.disabled = true;
    this.button.addEventListener('click', () => this.start('calibration'));
    this.validateButton.addEventListener('click', () => this.start('validation'));
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

  // mode: 'calibration' fits the model on the nine dots; 'validation' only scores held-out dots against the fitted model.
  start(mode = 'calibration') {
    if (mode === 'validation' && !this.input.calibration.model) return;
    this.mode = mode;
    this.targets = mode === 'validation' ? VALIDATION_TARGETS : CALIBRATION_TARGETS;
    this.message = null;
    this.input.calibrating = true;
    if (mode === 'calibration') {
      this.input.calibration.clear();
      this.input.output = null;
      this.dataset.calibration = { samples: [] };
      this.result.textContent = '';
    }
    this.samples = [];
    this.frames = [];
    this.index = 0;
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
    // The smoothed output was following the overlay dots; don't let it leak back into interaction.
    if (this.input.calibrating) this.input.output = null;
    this.input.calibrating = false;
    this.overlay.hidden = true;
  }

  observe(now) {
    if (!this.input.calibrating) return;
    const raw = this.input.raw;
    const elapsed = now - this.startedAt;
    const valid = raw?.features && now - this.input.lastReceived < 250;
    const label = `${this.mode === 'validation' ? 'Validation' : 'Look at the dot'} · ${this.index + 1} / ${this.targets.length}`;
    this.instruction.textContent = valid
      ? `${label} · ${elapsed < 600 ? 'settle your eyes' : 'keep looking…'}`
      : `${label} · face the camera with eyes open`;
    // Ignore the saccade after a target moves; collect distinct observations, not repeated hand frames.
    if (!valid || elapsed < 600 || raw.t === this.lastSampleTime) return;
    this.lastSampleTime = raw.t;
    this.targetSamples.push(raw.features);
    this.frames.push(recordGaze(this.input, this.targets[this.index], now));
    if (elapsed < 1500 || this.targetSamples.length < 10) return;
    const features = Array.from({ length: 4 }, (_, i) => median(this.targetSamples.map(sample => sample[i])));
    this.samples.push({ features, target: this.targets[this.index] });
    if (++this.index < this.targets.length) {
      this.nextTarget();
      return;
    }
    if (this.mode === 'validation') this.finishValidation();
    else this.finishCalibration();
    this.cancel();
  }

  finishCalibration() {
    this.dataset.calibration.samples = this.frames;
    try {
      this.input.calibration.fit(this.samples);
      this.input.status = 'calibrated · look at a block, then pinch';
    } catch (error) {
      this.input.status = error.message;
      this.message = error.message;
    }
  }

  // Scores held-out dots with the fitted model. Never fits, never touches the bias.
  finishValidation() {
    try {
      const summary = summarizeValidation(this.frames.filter(f => f.prediction),
        { width: window.innerWidth, height: window.innerHeight });
      this.dataset.validation.push({ samples: this.frames, summary });
      this.result.textContent = `gaze error: mean ${Math.round(summary.meanPx)} px · p90 ${Math.round(summary.p90Px)} px`
        + ` (${summary.meanScreenHeights.toFixed(2)} / ${summary.p90ScreenHeights.toFixed(2)} screen heights)`;
      console.info(`[gaze] ${this.result.textContent}`);
    } catch (error) {
      this.result.textContent = error.message;
    }
  }

  // Runs every frame, so every write is skipped unless the value changed: a style or text write dirties layout, and
  // doing it 60 times a second for nothing cost a full style recalc and layout per frame.
  update(now, target, holding) {
    const canValidate = !(this.input.source === 'webcam' && this.input.calibration.model);
    if (canValidate !== this.lastValidateDisabled) this.validateButton.disabled = this.lastValidateDisabled = canValidate;
    const point = this.input.get(now);
    if (!point !== this.lastHidden) this.reticle.hidden = this.lastHidden = !point;
    if (point) {
      const left = `${(point.x * 100).toFixed(2)}%`;
      const top = `${(point.y * 100).toFixed(2)}%`;
      if (left !== this.lastLeft) this.reticle.style.left = this.lastLeft = left;
      if (top !== this.lastTop) this.reticle.style.top = this.lastTop = top;
      if (!!target !== this.lastOnTarget) this.reticle.classList.toggle('on-target', this.lastOnTarget = !!target);
    }
    const status = this.message || this.input.status;
    const refined = now - this.input.refinedAt < 1500 ? ' · gaze refined' : '';
    const text = `${status}${holding ? ` · holding ${holding}` : target ? ` · target ${target}` : ''}${refined}`;
    if (text !== this.lastText) this.status.textContent = this.lastText = text;
  }
}
