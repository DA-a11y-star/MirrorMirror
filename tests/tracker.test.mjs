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
