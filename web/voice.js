// Browser microphone -> 24 kHz mono PCM WAV, the format required by Muse Transcribe.
export function encodeWav(samples, rate = 24000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset+i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate*2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data');
  view.setUint32(40, samples.length*2, true);
  samples.forEach((value, i) => {
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(44+i*2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  });
  return buffer;
}

export async function recordingToWav(blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (decoded.duration < .1 || decoded.duration > 16) throw new Error('Record between 0.1 and 15 seconds');
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 24000), 24000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return encodeWav((await offline.startRendering()).getChannelData(0));
  } finally {
    await context.close();
  }
}

const SPEECH_RMS = 0.025; // mic level that counts as speech
const SILENCE_MS = 1300; // quiet this long after speech ends an automatic recording
const NO_SPEECH_MS = 6000; // nobody spoke: give up

export class Voice {
  constructor(url, onEvent) {
    this.url = url;
    this.onEvent = onEvent;
    this.connected = false;
    this.configured = false;
    this.busy = false;
    this.recording = false;
    this.starting = false;
    this.captureId = 0;
    this.closed = false;
    this.connect();
  }

  emit(type, fields = {}) { this.onEvent({ type, ...fields }); }

  connect() {
    const socket = this.socket = new WebSocket(this.url);
    socket.onmessage = event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ready') {
          this.connected = true;
          this.configured = msg.configured;
          // Audio stops at the transcript, so the object library is checked before Muse designs anything; the UI
          // then sends the text as a normal generate request if no library entry matches.
          socket.send(JSON.stringify({ type: 'options', designAudio: false }));
        }
        if (['object', 'error', 'undo', 'transcript'].includes(msg.type)) {
          clearTimeout(this.requestTimer);
          this.busy = false;
        }
        this.onEvent(msg);
      } catch (error) { this.fail(error); }
    };
    socket.onerror = () => {}; // onclose handles reconnect and status once.
    socket.onclose = () => {
      clearTimeout(this.requestTimer);
      this.connected = this.configured = this.busy = false;
      this.cancelRecording();
      if (!this.closed) {
        if (this.resetting) { // cancel(): reconnect straight away, and say nothing
          this.resetting = false;
          this.retry = setTimeout(() => this.connect(), 100);
        } else {
          this.emit('offline');
          this.retry = setTimeout(() => this.connect(), 2000);
        }
      }
    };
  }

  fail(error) {
    clearTimeout(this.requestTimer);
    this.busy = false;
    this.emit('error', { message: error.message || String(error) });
  }

  send(payload, { needsKey = true } = {}) {
    if (!this.connected) throw new Error('Start the local voice service first');
    if (needsKey && !this.configured) throw new Error('Set MODEL_API_KEY and restart the voice service');
    if (this.busy) throw new Error('An object is already being generated');
    this.socket.send(payload);
    this.busy = true;
    this.emit('status', { stage: 'sending' });
    // Closing on timeout prevents a late response from becoming the next request's object.
    this.requestTimer = setTimeout(() => {
      this.fail(new Error('Voice request timed out. Reconnecting…'));
      this.socket.close();
    }, 160000);
  }

  generate(text) {
    if (this.busy || this.recording || this.starting) return;
    text = text.trim();
    if (!text || text.length > 2000) return this.fail(new Error('Describe an object in 1–2000 characters'));
    try { this.send(JSON.stringify({ type: 'generate', text }), { needsKey: !/^undo[.!?]?$/i.test(text) }); }
    catch (error) { this.fail(error); }
  }

  // `auto` (the fist trigger) ends the recording itself: after SILENCE_MS of quiet once speech has been heard, or
  // gives up if nothing is said within NO_SPEECH_MS. Hold-to-speak leaves stopping to the button.
  async startRecording(auto = false) {
    if (this.busy || this.recording || this.starting) return;
    if (!this.connected || !this.configured) return this.fail(new Error('Start the voice service with MODEL_API_KEY first'));
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return this.fail(new Error('Microphone recording is unavailable. Use localhost in a current browser or type a description'));
    }
    this.starting = true;
    const captureId = ++this.captureId;
    this.emit('status', { stage: 'microphone' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
      // The button can be released while the permission prompt is open.
      if (captureId !== this.captureId || !this.starting || !this.connected || this.closed) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']
        .find(type => MediaRecorder.isTypeSupported(type));
      const recorder = this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        this.cancelRecording();
        this.fail(new Error('Microphone recording failed. Try again or type a description'));
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        this._stopWatch();
        if (captureId !== this.captureId) return;
        clearTimeout(this.recordTimer);
        this.stream = null;
        this.recorder = null;
        this.recording = false;
        this.busy = true;
        this.emit('status', { stage: 'encoding' });
        try {
          const wav = await recordingToWav(new Blob(chunks, { type: recorder.mimeType }));
          if (captureId !== this.captureId || this.closed) return;
          this.busy = false;
          this.send(wav);
        } catch (error) { if (captureId === this.captureId) this.fail(error); }
      };
      recorder.start();
      this.starting = false;
      this.recording = true;
      this.emit('status', { stage: 'listening' });
      if (auto) this._watchSilence(stream, captureId);
      this.recordTimer = setTimeout(() => this.stopRecording(), 15000);
    } catch (error) {
      if (captureId === this.captureId) {
        this.stream?.getTracks().forEach(track => track.stop());
        this.starting = false;
        this.fail(error);
      }
    } finally {
      if (captureId === this.captureId) this.starting = false;
    }
  }

  // Abandon whatever is in progress: a recording, or a request still waiting on the model. The connection is dropped and
  // re-made for the latter so the late answer can never turn up as the next request's object. True if there was work.
  cancel() {
    if (!(this.busy || this.recording || this.starting)) return false;
    this.cancelRecording();
    if (this.busy) {
      clearTimeout(this.requestTimer);
      this.resetting = true;
      this.socket.onmessage = null;
      this.socket.close();
    }
    this.busy = false;
    this.emit('status', { stage: 'idle' });
    this.emit('cancelled');
    return true;
  }

  stopRecording() {
    if (this.starting) {
      this.captureId++;
      this.starting = false;
      this.emit('status', { stage: 'idle' });
    }
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  // Polls the mic level. Stops the recording shortly after the speaker goes quiet; cancels if nobody speaks.
  _watchSilence(stream, captureId) {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    let heard = false;
    let lastLoud = startedAt;
    const timer = setInterval(() => {
      if (captureId !== this.captureId) return this._stopWatch();
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
      const now = performance.now();
      if (rms > SPEECH_RMS) { heard = true; lastLoud = now; }
      if (heard && now - lastLoud > SILENCE_MS) this.stopRecording();
      else if (!heard && now - startedAt > NO_SPEECH_MS) {
        this.cancelRecording();
        this.emit('status', { stage: 'idle' });
        this.emit('nospeech');
      }
    }, 50);
    this.watch = { timer, context };
  }

  _stopWatch() {
    if (!this.watch) return;
    clearInterval(this.watch.timer);
    this.watch.context.close().catch(() => {});
    this.watch = null;
  }

  cancelRecording() {
    this._stopWatch();
    this.captureId++;
    this.starting = false;
    clearTimeout(this.recordTimer);
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop());
    this.recording = false;
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearTimeout(this.requestTimer);
    this.cancelRecording();
    this.socket.close();
  }
}
