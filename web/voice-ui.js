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
    this.cue = document.createElement('div');
    this.cue.id = 'voice-cue';
    this.cue.hidden = true;
    this.cue.textContent = '🎙 Listening — say “mirror mirror, make a …”';
    document.body.appendChild(this.cue);
    const style = document.createElement('style');
    style.textContent = `#voice-cue { position: fixed; top: 44px; left: 50%; transform: translateX(-50%); z-index: 5; pointer-events: none;
      font: 600 14px system-ui, sans-serif; color: white; background: #e76f51; padding: 7px 16px; border-radius: 999px;
      box-shadow: 0 0 0 3px rgba(255,255,255,.7), 0 0 18px #e76f51; animation: voice-pulse 1s ease-in-out infinite; }
      @keyframes voice-pulse { 50% { opacity: .65; } }`;
    document.head.appendChild(style);
    this.refresh();
  }

  // The single-fist trigger (or T): listen for "mirror mirror, make a …" and stop on silence.
  wake() {
    if (this.voice.busy || this.voice.recording || this.voice.starting) return;
    if (!this.voice.connected || !this.voice.configured) {
      this.status.textContent = 'Voice isn\'t ready: start python -m voice.main with MODEL_API_KEY.';
      return;
    }
    this._beep(880);
    this.voice.startRecording(true);
  }

  _beep(freq) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.07, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
      osc.start();
      osc.stop(ctx.currentTime + 0.14);
      osc.onended = () => ctx.close();
    } catch { /* audio may be blocked until the first click */ }
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
    if (msg.type === 'status') {
      this.status.textContent = labels[msg.stage] || msg.stage;
      // The dust cloud swirls from the moment audio is sent until the object (or an error) comes back.
      if (['encoding', 'sending', 'transcribing', 'designing'].includes(msg.stage)) this.onBuild?.('start');
    }
    if (msg.type === 'transcript') this.input.value = msg.text;
    if (msg.type === 'error') { this.status.textContent = msg.message; this.onBuild?.('stop'); }
    if (msg.type === 'nospeech') this.status.textContent = 'Didn\'t hear anything. Make a fist again and say “mirror mirror, make a …”.';
    if (msg.type === 'undo') { this.onBuild?.('stop'); this.undoObject(); }
    if (msg.type === 'object') {
      try {
        const root = this.objects.add(msg.spec);
        this.onBuild?.('done', root);
        this.status.textContent = `${root.name} · ${root.children.length} parts · ${msg.seconds}s. Look and pinch to move it.`;
      } catch (error) { this.status.textContent = error.message; this.onBuild?.('stop'); }
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
    this.cue.hidden = !(voice.recording || voice.starting || voice.busy);
    this.cue.textContent = voice.busy && !voice.recording ? '✨ Building…' : '🎙 Listening — say “mirror mirror, make a …”';
  }
}
