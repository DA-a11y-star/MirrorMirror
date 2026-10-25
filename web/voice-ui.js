import { Voice } from './voice.js';

// Voice and typed object requests. A request that names a library entry outright ("a chair", "another tree") is
// built from the library with no Muse call, which also works when the voice service or internet is down; anything
// else goes to Muse, and every object Muse makes is saved to the library.
export class VoiceUI {
  constructor(url, objects, library = null, { onLibraryChange } = {}) {
    this.objects = objects;
    this.library = library;
    this.onLibraryChange = onLibraryChange;
    this.status = document.getElementById('voice-status');
    this.input = document.getElementById('object-description');
    this.record = document.getElementById('voice-record');
    this.build = document.getElementById('voice-build');
    this.undo = document.getElementById('voice-undo');
    this.voice = new Voice(url, msg => this.event(msg));
    document.getElementById('voice-form').addEventListener('submit', e => {
      e.preventDefault();
      this.request(this.input.value);
    });
    this.input.addEventListener('input', () => this.refresh());
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
    document.getElementById('voice-tools').appendChild(this.cue);
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

  // The user switched modes: drop the recording or the pending build and stop the loading animation.
  cancel() {
    if (this.voice.cancel()) this.onBuild?.('stop');
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

  request(text) {
    const entry = this.library?.match(text);
    if (entry) this.addFromLibrary(entry);
    else this.voice.generate(text);
  }

  addFromLibrary(entry) {
    try {
      const root = this.objects.add(this.library.instantiate(entry.id));
      this.onBuild?.('done', root); // a spoken request started the dust cloud; no Muse object will arrive to end it
      this.status.textContent = `${entry.name} from the library (no Muse call). Look and pinch to move it.`;
    } catch (error) { this.status.textContent = error.message; this.onBuild?.('stop'); }
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
    if (msg.type === 'offline') {
      this.status.textContent = 'Voice is reconnecting. You can still build saved library objects.';
      this.status.title = 'Start the local voice service with: python -m voice.main';
    }
    if (msg.type === 'ready') this.status.removeAttribute('title');
    if (msg.type === 'status') {
      this.status.textContent = labels[msg.stage] || msg.stage;
      // The dust cloud swirls from the moment audio is sent until the object (or an error) comes back.
      if (['encoding', 'sending', 'transcribing', 'designing'].includes(msg.stage)) this.onBuild?.('start');
    }
    if (msg.type === 'transcript') {
      this.input.value = msg.text;
      this.request(msg.text); // the server stops at the transcript: library first, then Muse
    }
    if (msg.type === 'error') { this.status.textContent = msg.message; this.onBuild?.('stop'); }
    if (msg.type === 'cancelled') this.status.textContent = 'Build cancelled.';
    if (msg.type === 'nospeech') this.status.textContent = 'Didn\'t hear anything. Make a fist again and say “mirror mirror, make a …”.';
    if (msg.type === 'undo') { this.onBuild?.('stop'); this.undoObject(); }
    if (msg.type === 'object') {
      try {
        const root = this.objects.add(msg.spec);
        this.onBuild?.('done', root);
        const saved = this.library?.save(msg.spec);
        if (saved?.added) this.onLibraryChange?.();
        this.status.textContent = `${root.name} · ${root.children.length} parts · ${msg.seconds}s${saved?.added ? ' · saved to the library' : ''}. Look and pinch to move it.`;
      } catch (error) { this.status.textContent = error.message; this.onBuild?.('stop'); }
    }
    this.refresh();
  }

  refresh() {
    const voice = this.voice;
    if (!voice) return;
    // A name the library knows needs no voice service; anything else needs a connected, configured one.
    const fromLibrary = !!this.library?.match(this.input.value);
    this.build.disabled = voice.busy || voice.recording || voice.starting || (!fromLibrary && (!voice.connected || !voice.configured));
    // Keep the active record button enabled so it keeps pointer capture and receives release.
    this.record.disabled = !voice.connected || !voice.configured || (voice.busy && !voice.recording);
    this.record.textContent = voice.recording ? 'Release to build' : voice.starting ? 'Opening microphone…' : 'Hold to speak';
    this.record.setAttribute('aria-pressed', String(voice.recording));
    this.undo.disabled = !this.objects.history.length;
    this.cue.hidden = !(voice.recording || voice.starting || voice.busy);
    this.cue.textContent = voice.busy && !voice.recording ? 'Bringing your idea to life…' : 'Listening — describe what you want to make.';
    document.getElementById('voice-tools').dataset.state = voice.recording || voice.starting ? 'listening' : voice.busy ? 'building' : 'idle';
  }
}
