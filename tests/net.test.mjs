import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Net, validScene, validState } from '../web/net.js';

const AVATAR = { pos: [0, 0, -3], vel: [0, 0, 0], yaw: Math.PI, pitch: -.35, flying: false };
const lm = () => Array.from({ length: 21 }, () => [0, 0, .45]);
const state = (user = 'B', seq = 1, extra = {}) => ({
  type: 'state', user, seq, avatar: AVATAR, head: { quat: [0, 0, 0, 1] }, target: 'b1',
  hands: [{ side: 'right', pinch: .5, lm: lm() }], held: [{ id: 'b2', pos: [0, .5, 0], quat: [0, 0, 0, 1] }], ...extra,
});
const scene = (user = 'A', seq = 1) => ({ type: 'scene', user, seq, objects: [{ id: 'b1', pos: [0, 0, 0], quat: [0, 0, 0, 1] }] });

function setup(t, userId = 'A') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  class Socket {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.onclose?.(); }
    open() { this.onopen(); }
    receive(msg) { this.onmessage({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
  }
  const messages = [], statuses = [];
  const net = new Net('ws://relay', userId, msg => messages.push(msg), status => statuses.push(status), { WebSocketClass: Socket });
  t.after(() => net.stop());
  return { net, sockets, messages, statuses, tick: ms => t.mock.timers.tick(ms) };
}

test('validates the state contract before anything is drawn from it', () => {
  assert.equal(validState(state()), true);
  assert.equal(validState(state('B', 1, { head: null, target: null, hands: [], held: [] })), true);
  assert.equal(validState(null), false);
  assert.equal(validState(state('B', 1, { type: 'scene' })), false);
  assert.equal(validState(state('B', NaN)), false);
  for (const bad of [{ pos: [0, 1] }, { pos: [0, NaN, 0] }, { vel: undefined }, { yaw: NaN }, { pitch: '0' }, { flying: 0 }]) {
    assert.equal(validState(state('B', 1, { avatar: { ...AVATAR, ...bad } })), false, JSON.stringify(bad));
  }
  assert.equal(validState(state('B', 1, { avatar: null })), false);
  assert.equal(validState(state('B', 1, { head: { quat: [0, 0, 1] } })), false);
  assert.equal(validState(state('B', 1, { target: 7 })), false);
  const short = state(); short.hands[0].lm.pop();
  assert.equal(validState(short), false);
  const nan = state(); nan.hands[0].lm[3][1] = NaN;
  assert.equal(validState(nan), false);
  assert.equal(validState(state('B', 1, { hands: [{ side: 'up', pinch: 0, lm: lm() }] })), false);
  assert.equal(validState(state('B', 1, { hands: [{ side: 'left', pinch: 2, lm: lm() }] })), false);
  const three = state(); three.hands = [three.hands[0], three.hands[0], three.hands[0]];
  assert.equal(validState(three), false);
  assert.equal(validState(state('B', 1, { held: [{ id: 5, pos: [0, 0, 0], quat: [0, 0, 0, 1] }] })), false);
  assert.equal(validState(state('B', 1, { held: [{ id: 'b2', pos: [0, 0, 0] }] })), false);
});

test('validates the scene contract', () => {
  assert.equal(validScene(scene()), true);
  assert.equal(validScene({ ...scene(), objects: [{ id: 'b1', pos: [0, 0, NaN], quat: [0, 0, 0, 1] }] }), false);
  assert.equal(validScene({ ...scene(), objects: Array.from({ length: 65 }, () => scene().objects[0]) }), false);
  assert.equal(validScene({ ...scene(), objects: 'all' }), false);
  assert.equal(validScene(state()), false);
});

test('a scene may carry assembly poses without recipes, but never a malformed pose or an oversized list', () => {
  const pose = (extra = {}) => ({ id: 'generated-a', kind: 'assembly', pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1], ...extra });
  const withObjects = (...objects) => ({ ...scene(), objects });
  assert.equal(validScene(withObjects(pose())), true);
  for (const bad of [{ pos: [0, 0, NaN] }, { quat: [0, 0, 0, 0] }, { scale: [0, 1, 1] }, { scale: [1, 1] }, { scale: undefined }, { id: '' }]) {
    assert.equal(validScene(withObjects(pose(bad))), false, JSON.stringify(bad));
  }
  assert.equal(validScene(withObjects(pose({ spec: { version: 1, id: 'generated-a', name: 'x', position: [0, 0, 0], quaternion: [0, 0, 0, 1], parts: [] } }))), false,
    'a recipe that is present is still fully checked');
  const ids = n => Array.from({ length: n }, (_, i) => `id-${i}`);
  assert.equal(validScene({ ...scene(), deleted: ids(256), acks: ids(256) }), true);
  assert.equal(validScene({ ...scene(), deleted: ids(257) }), false);
  assert.equal(validScene({ ...scene(), acks: ids(257) }), false);
});

test('passes valid messages from other users and drops echoes, junk and unknown types', t => {
  const s = setup(t), socket = s.sockets[0];
  socket.open();
  socket.receive(state('B'));
  socket.receive(state('A', 5)); // our own id: never ours to apply
  socket.receive('not json');
  socket.receive({ type: 'op', user: 'B', seq: 9, op: 'add' });
  socket.receive(state('B', 7, { held: 'b2' }));
  socket.receive(scene('B', 8));
  assert.deepEqual(s.messages.map(m => `${m.type}:${m.user}:${m.seq}`), ['state:B:1', 'scene:B:8']);
});

test('drops old and repeated sequence numbers per sender and message type', t => {
  const s = setup(t), socket = s.sockets[0];
  socket.open();
  for (const seq of [5, 5, 4, 6]) socket.receive(state('B', seq));
  socket.receive(scene('B', 1)); // a different type has its own count
  socket.receive(state('C', 1)); // and so does another sender
  assert.deepEqual(s.messages.map(m => `${m.type}:${m.user}:${m.seq}`), ['state:B:5', 'state:B:6', 'scene:B:1', 'state:C:1']);
});

test('send stamps the sender and an increasing sequence number, and drops snapshots while not connected', t => {
  const s = setup(t), socket = s.sockets[0];
  assert.equal(s.net.send({ type: 'state' }), false);
  assert.deepEqual(socket.sent, []);
  socket.open();
  assert.equal(s.net.send({ type: 'state', held: [] }), true);
  assert.equal(s.net.send({ type: 'scene', objects: [] }), true);
  const [first, second] = socket.sent;
  assert.equal(first.user, 'A');
  assert.deepEqual(first.held, []);
  assert.equal(second.type, 'scene');
  assert.ok(second.seq > first.seq);
  socket.bufferedAmount = 2 ** 21;
  assert.equal(s.net.send({ type: 'state' }), false, 'a backed-up link gets no more snapshots');
  assert.equal(socket.sent.length, 2);
});

test('reconnects after the link drops and reports each status once', t => {
  const s = setup(t), first = s.sockets[0];
  first.open();
  first.close();
  assert.equal(s.net.send({ type: 'state' }), false);
  s.tick(1000);
  assert.equal(s.sockets.length, 2);
  s.sockets[1].open();
  assert.equal(s.net.send({ type: 'state' }), true);
  assert.deepEqual(s.statuses, ['connecting', 'connected', 'disconnected; retrying', 'connecting', 'connected']);
});

test('stop closes the link for good', t => {
  const s = setup(t), socket = s.sockets[0];
  socket.open();
  s.net.stop();
  s.tick(5000);
  assert.equal(s.sockets.length, 1);
  assert.equal(s.net.send({ type: 'state' }), false);
});

test('a hand may carry `rest` (MOVE mode, stick not engaged): a boolean or nothing; anything else is rejected', () => {
  const withRest = rest => state('B', 1, { hands: [{ side: 'right', pinch: 0, lm: lm(), ...(rest === undefined ? {} : { rest }) }] });
  for (const ok of [undefined, true, false, null]) assert.equal(validState(withRest(ok)), true, String(ok));
  for (const bad of ['yes', 1, [], {}]) assert.equal(validState(withRest(bad)), false, JSON.stringify(bad));
});
