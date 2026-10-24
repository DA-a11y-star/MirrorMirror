import { Voice } from './voice.js';

export class VoiceUI {
  constructor(url, objects) {
    this.objects = objects;
    this.status = document.getElementById('voice-status');
    this.input = document.getElementById('object-description');
    this.record = document.getElementById('voice-record');
    this.build = document.getElementById('voice-build');
    this.undo = document.getElementById('voice-undo');
    this.voice = new Voice(url, msg => this.event(msg));
    document.getElementById('voice-form').addEventListener('submit', e => {
      e.preventDefault();
      this.voice.generate(this.input.value);
    });
    this.undo.addEventListener('click', () => this.undoObject());
    this.record.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.record.setPointerCapture(e.pointerId);
      this.voice.startRecording();
    });
    this.record.addEventListener('pointerup', () => this.voice.stopRecording());
    this.record.addEventListener('pointercancel', () => this.voice.stopRecording());
    this.record.addEventListener('lostpointercapture', () => this.voice.stopRecording());
    this.record.addEventListener('keydown', e => {
      if ([' ', 'Enter'].includes(e.key)) {
        e.preventDefault();
        if (!e.repeat) this.voice.startRecording();
      }
    });
    this.record.addEventListener('keyup', e => {
      if ([' ', 'Enter'].includes(e.key)) { e.preventDefault(); this.voice.stopRecording(); }
    });
    window.addEventListener('blur', () => this.voice.stopRecording());
    window.addEventListener('pagehide', () => this.voice.close(), { once: true });
    this.refresh();
  }

  undoObject() {
    this.status.textContent = this.objects.undo() ? 'Last creation removed.' : 'No generated objects to undo.';
    this.refresh();
  }

  event(msg) {
    const labels = {
      microphone: 'Allow microphone access, then hold again if you released.',
      listening: 'Listening… release to build (15 seconds maximum).',
      encoding: 'Preparing audio…', sending: 'Sending…',
      transcribing: 'Transcribing with Muse…', designing: 'Designing with Muse Wonder…',
      idle: 'Hold the microphone button or type an object description.',
    };
    if (msg.type === 'ready') this.status.textContent = msg.configured
      ? labels.idle : 'Voice service connected. Set MODEL_API_KEY and restart it to build.';
    if (msg.type === 'offline') this.status.textContent = 'Voice offline — run python -m voice.main. Reconnecting…';
    if (msg.type === 'status') this.status.textContent = labels[msg.stage] || msg.stage;
    if (msg.type === 'transcript') this.input.value = msg.text;
    if (msg.type === 'error') this.status.textContent = msg.message;
    if (msg.type === 'undo') this.undoObject();
    if (msg.type === 'object') {
      try {
        const root = this.objects.add(msg.spec);
        this.status.textContent = `${root.name} · ${root.children.length} parts · ${msg.seconds}s. Look and pinch to move it.`;
      } catch (error) { this.status.textContent = error.message; }
    }
    this.refresh();
  }

  refresh() {
    const voice = this.voice;
    if (!voice) return;
    this.build.disabled = !voice.connected || !voice.configured || voice.busy || voice.recording || voice.starting;
    // Keep the active record button enabled so it keeps pointer capture and receives release.
    this.record.disabled = !voice.connected || !voice.configured || (voice.busy && !voice.recording);
    this.record.textContent = voice.recording ? '● Release to build' : 'Hold to speak';
    this.record.setAttribute('aria-pressed', String(voice.recording));
    this.undo.disabled = !this.objects.history.length;
  }
}
