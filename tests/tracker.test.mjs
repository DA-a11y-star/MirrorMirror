import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTracker, validFrame } from '../web/tracker.js';

function frame(t = 1, pinching = true) {
  return { type: 'frame', t, hands: [{ side: 'right', pinch: 0.7, pinching,
    lm: Array.from({ length: 21 }, () => [0, 0, .45]) }], gaze: null, head: null };
}

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = [];
  class Socket {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.onclose?.(); }
    open() { this.onopen(); }
    send(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
  }
  let time = 0;
  const messages = [], statuses = [];
  const stop = startTracker('ws://localhost:8766', msg => messages.push(msg), status => statuses.push(status),
    { WebSocketClass: Socket, now: () => time });
  t.after(stop);
  return { sockets, messages, statuses, stop, tick(ms) { time += ms; t.mock.timers.tick(ms); } };
}

test('validates the landmark contract before passing data to rendering', () => {
  assert.equal(validFrame(frame()), true);
  const short = frame(); short.hands[0].lm.pop();
  assert.equal(validFrame(short), false);
  const invalid = frame(); invalid.hands[0].lm[0][0] = NaN;
  assert.equal(validFrame(invalid), false);
  const duplicate = frame(); duplicate.hands.push(duplicate.hands[0]);
  assert.equal(validFrame(duplicate), false);
  assert.equal(validFrame(null), false);
});

test('snapshot plus explicit event emits one transition, and ignores old frames', t => {
  const s = setup(t), socket = s.sockets[0];
  socket.open();
  socket.send(frame());
  socket.send({ type: 'gesture', name: 'pinch_start', hand: 'right' });
  socket.send(frame(.5, false));
  socket.send(frame(2, false));
  socket.send({ type: 'gesture', name: 'pinch_end', hand: 'right' });
  assert.deepEqual(s.messages.filter(m => m.type === 'gesture').map(m => m.name), ['pinch_start', 'pinch_end']);
  assert.deepEqual(s.messages.filter(m => m.type === 'frame').map(m => m.t), [1, 2]);
});

test('stalled feed clears hands and releases pinch once; fresh data recovers', t => {
  const s = setup(t), socket = s.sockets[0];
  socket.open(); socket.send(frame());
  s.tick(600);
  assert.deepEqual(s.messages.at(-1).hands, []);
  assert.equal(s.statuses.at(-1), 'stalled; hands cleared');
  const count = s.messages.length;
  s.tick(600);
  assert.equal(s.messages.length, count);
  socket.send(frame(2));
  assert.equal(s.statuses.at(-1), 'live');
  assert.equal(s.messages.at(-1).name, 'pinch_start');
});

test('disconnect releases immediately; reconnect accepts restarted clock', t => {
  const s = setup(t), first = s.sockets[0];
  first.open(); first.send(frame(100)); first.close();
  assert.deepEqual(s.messages.at(-1).hands, []);
  assert.equal(s.messages.at(-2).name, 'pinch_end');
  s.tick(1000);
  assert.equal(s.sockets.length, 2);
  const second = s.sockets[1];
  second.open(); second.send(frame(1));
  assert.equal(s.messages.at(-1).name, 'pinch_start');
  s.stop(); s.tick(3000);
  assert.equal(s.sockets.length, 2);
});

test('malformed messages do not refresh the watchdog', t => {
  const s = setup(t), socket = s.sockets[0];
  socket.open(); socket.send(frame());
  socket.onmessage({ data: '{' });
  socket.send({ ...frame(2), hands: 'bad' });
  socket.send(null);
  s.tick(600);
  assert.deepEqual(s.messages.at(-1).hands, []);
});

test('independent gaze is deduplicated without keeping stale hands alive', t => {
  const s = setup(t), socket = s.sockets[0];
  const gaze = stamp => ({ type: 'gaze', t: stamp, gaze: { t: stamp, source: 'glasses', conf: .9 } });
  socket.open();
  socket.send(gaze(100)); // gaze can arrive before any hand frame
  socket.send(gaze(100));
  socket.send(gaze(99));
  socket.send({ ...gaze(101), gaze: { t: 101, conf: 2 } });
  assert.equal(s.messages.filter(m => m.type === 'gaze').length, 1);
  socket.send(frame(1));
  s.tick(300);
  socket.send(gaze(102));
  s.tick(300);
  assert.equal(s.statuses.at(-1), 'stalled; hands cleared');
  assert.deepEqual(s.messages.at(-1).hands, []);
  assert.equal(s.messages.filter(m => m.type === 'gesture' && m.name === 'pinch_end').length, 1);
  socket.close();
  s.tick(1000);
  const second = s.sockets[1];
  second.open(); second.send(gaze(1));
  assert.equal(s.messages.at(-1).t, 1, 'gaze clock resets on reconnect');
});

test('browser marker geometry is sent on connection, resize and reconnect', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = [], sent = [];
  class Socket {
    constructor() { sockets.push(this); this.readyState = 0; }
    send(data) { sent.push(JSON.parse(data)); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  let layout = { id: 'first', version: 1 };
  const stop = startTracker('ws://localhost:8766', () => {}, () => {}, {
    WebSocketClass: Socket, getScreenLayout: () => layout,
  });
  t.after(stop);
  sockets[0].open();
  assert.deepEqual(sent.at(-1), { type: 'screen_layout', layout });
  layout = { id: 'resized', version: 1 };
  stop.sendScreenLayout();
  assert.equal(sent.at(-1).layout.id, 'resized');
  sockets[0].close();
  t.mock.timers.tick(1000);
  sockets[1].open();
  assert.equal(sent.at(-1).layout.id, 'resized');
  layout = null;
  stop.sendScreenLayout();
  assert.equal(sent.at(-1).layout, null, 'leaving glasses mode releases the browser layout');
});
