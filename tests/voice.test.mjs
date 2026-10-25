import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Voice } from '../web/voice.js';

class FakeSocket {
  sent = [];
  send(payload) { this.sent.push(payload); }
  receive(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
  close() { this.onclose(); }
}

function setup(context) {
  context.mock.method(globalThis, 'WebSocket', function () { return new FakeSocket(); });
  const events = [];
  const voice = new Voice('ws://localhost:8767', event => events.push(event));
  context.after(() => voice.close());
  voice.socket.receive({ type: 'ready', configured: true });
  // On connect the client asks for transcribe-only audio, so the object library is checked before Muse designs.
  assert.deepEqual(JSON.parse(voice.socket.sent[0]), { type: 'options', designAudio: false });
  voice.socket.sent.length = 0;
  return { voice, events };
}
const generates = voice => voice.socket.sent.filter(m => typeof m === 'string').map(m => JSON.parse(m)).filter(m => m.type === 'generate');

test('one generation at a time and a failed request leaves the client ready to retry', context => {
  const { voice, events } = setup(context);
  voice.generate('A blue chair');
  voice.generate('A tree');
  assert.equal(voice.socket.sent.length, 1);
  assert.equal(voice.busy, true);
  voice.socket.receive({ type: 'error', message: 'API key rejected' });
  assert.equal(voice.busy, false);
  assert.equal(events.at(-1).message, 'API key rejected');
  voice.generate('A tree');
  voice.socket.receive({ type: 'object', spec: {} });
  assert.equal(voice.socket.sent.length, 2);
  assert.equal(voice.busy, false);
});

test('releasing before microphone permission resolves stops the microphone without recording or uploading', async context => {
  const { voice } = setup(context);
  let permit, stopped = 0;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: () => new Promise(resolve => { permit = resolve; }) },
  } });
  globalThis.window = { MediaRecorder: class {} };
  context.after(() => {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    delete globalThis.window;
  });
  const pending = voice.startRecording();
  assert.equal(voice.starting, true);
  voice.stopRecording();
  permit({ getTracks: () => [{ stop() { stopped++; } }] });
  await pending;
  assert.equal(stopped, 1);
  assert.equal(voice.recording, false);
  assert.equal(voice.starting, false);
  assert.equal(voice.socket.sent.length, 0);
});

test('missing API configuration prevents requests while undo can still be sent', context => {
  const { voice, events } = setup(context);
  voice.socket.receive({ type: 'ready', configured: false });
  voice.generate('A chair');
  assert.equal(generates(voice).length, 0);
  assert.match(events.at(-1).message, /MODEL_API_KEY/);
  voice.generate('undo');
  assert.equal(generates(voice)[0].text, 'undo');
});

test('a transcript ends the audio request, so the UI can send the text (or use the library) next', context => {
  const { voice, events } = setup(context);
  voice.send(new ArrayBuffer(8));
  assert.equal(voice.busy, true);
  voice.socket.receive({ type: 'transcript', text: 'A chair' });
  assert.equal(voice.busy, false);
  assert.equal(events.at(-1).text, 'A chair');
  voice.generate('A chair');
  assert.equal(generates(voice).length, 1, 'not refused as "already generating"');
});

test('cancel drops a pending request: the late answer is ignored and the next request works', async context => {
  const { voice, events } = setup(context);
  const old = voice.socket;
  voice.generate('A blue chair');
  assert.equal(voice.busy, true);
  assert.equal(voice.cancel(), true);
  assert.equal(voice.busy, false);
  assert.equal(events.at(-1).type, 'cancelled');
  assert.ok(!events.some(e => e.type === 'offline'), 'an intentional reset is not reported as offline');
  assert.equal(old.onmessage, null, 'nothing the old connection says is heard any more');
  await new Promise(resolve => setTimeout(resolve, 200)); // reconnects on its own
  assert.notEqual(voice.socket, old, 'a fresh connection');
  voice.socket.receive({ type: 'ready', configured: true });
  // The server forgets per-connection options, so the fresh connection asks for transcribe-only audio again.
  assert.deepEqual(JSON.parse(voice.socket.sent[0]), { type: 'options', designAudio: false });
  voice.generate('A tree');
  assert.equal(generates(voice).length, 1);
  voice.socket.receive({ type: 'object', spec: { name: 'tree' } });
  assert.equal(events.at(-1).type, 'object');
  assert.equal(events.at(-1).spec.name, 'tree');
});

test('cancel with nothing in progress does nothing', context => {
  const { voice, events } = setup(context);
  const before = events.length;
  assert.equal(voice.cancel(), false);
  assert.equal(events.length, before);
});

test('cancel while the microphone permission prompt is open abandons the recording', async context => {
  const { voice } = setup(context);
  let permit, stopped = 0;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia: () => new Promise(resolve => { permit = resolve; }) },
  } });
  globalThis.window = { MediaRecorder: class {} };
  context.after(() => {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    delete globalThis.window;
  });
  const pending = voice.startRecording(true);
  assert.equal(voice.starting, true);
  assert.equal(voice.cancel(), true);
  permit({ getTracks: () => [{ stop() { stopped++; } }] });
  await pending;
  assert.equal(stopped, 1, 'the microphone is released');
  assert.equal(voice.recording, false);
  assert.equal(voice.socket.sent.length, 0);
});
