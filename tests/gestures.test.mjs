import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function load(name) {
  const path = new URL(`../web/${name}.js`, import.meta.url);
  const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
  const source = (await readFile(path, 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const { Gestures, curve, isolateAxes } = await load('gestures');

function hand(side, pose, extra = {}) {
  return {
    side, pose, pose_conf: extra.pose_conf ?? 0.9,
    palm: { x: extra.x ?? 0.5, y: extra.y ?? 0.5, scale: extra.scale ?? 0.12 },
    pinch: 0, pinching: pose === 'pinch', lm: [],
  };
}

function runToggle(steps) {
  const g = new Gestures();
  let now = 0;
  for (const [dt, hands] of steps) {
    now += dt;
    g.setFrame(hands, now);
  }
  return g;
}

test('curve: dead zone, full scale and expo', () => {
  assert.equal(curve(0.05, 0.12, 0.8, 1.5), 0);
  assert.equal(curve(0.8, 0.12, 0.8, 1.5), 1);
  assert.equal(curve(-0.8, 0.12, 0.8, 1.5), -1);
  const mid = curve(0.12 + 0.5 * (0.8 - 0.12), 0.12, 0.8, 1.5);
  assert.ok(mid > 0.3 && mid < 0.5, `expo bends below linear, got ${mid}`);
});

test('axis isolation damps the weaker axes when one dominates', () => {
  const out = isolateAxes({ lateral: 0.1, vertical: 0.1, depth: 0.8 }, 2, 0.5);
  assert.equal(out.depth, 0.8);
  assert.equal(out.lateral, 0.05);
  assert.equal(out.vertical, 0.05);
  const even = isolateAxes({ lateral: 0.5, vertical: 0.4, depth: 0.4 }, 2, 0.5);
  assert.deepEqual(even, { lateral: 0.5, vertical: 0.4, depth: 0.4 });
});

test('a pinch never arms the toggle, even with the other hand in a fist', () => {
  const g = runToggle([
    [20, [hand('left', 'pinch'), hand('right', 'fist')]],
    [200, [hand('left', 'pinch'), hand('right', 'fist')]],
    [20, [hand('left', 'open'), hand('right', 'open')]],
  ]);
  assert.equal(g.mode, 'MOVE');
  assert.equal(g.toggle.state, 'IDLE');
});

test('double fist then double open toggles MOVE ↔ EDIT; a single fist never does', () => {
  const bothFist = [hand('left', 'fist'), hand('right', 'fist')];
  const bothOpen = [hand('left', 'open'), hand('right', 'open')];
  const oneFist = [hand('left', 'fist'), hand('right', 'open')];

  const miss = runToggle([[20, oneFist], [200, oneFist], [20, bothOpen]]);
  assert.equal(miss.mode, 'MOVE');
  assert.equal(miss.toggle.state, 'IDLE');

  const g = runToggle([
    [20, bothFist],
    [160, bothFist],
    [20, bothOpen],
  ]);
  assert.equal(g.mode, 'EDIT');
  assert.equal(g.toggle.state, 'COOLDOWN');

  g.setFrame(bothOpen, 400);
  g.setFrame(bothFist, 1600);
  g.setFrame(bothFist, 1760);
  g.setFrame(bothOpen, 1780);
  assert.equal(g.mode, 'MOVE');
});

test('toggle: fists must start together; armed timeout and a lost hand cancel', () => {
  const late = runToggle([
    [0, [hand('left', 'fist'), hand('right', 'open')]],
    [800, [hand('left', 'fist'), hand('right', 'fist')]],
    [200, [hand('left', 'fist'), hand('right', 'fist')]],
    [20, [hand('left', 'open'), hand('right', 'open')]],
  ]);
  assert.equal(late.mode, 'MOVE', 'onsets far apart never arm');

  const timeout = runToggle([
    [0, [hand('left', 'fist'), hand('right', 'fist')]],
    [160, [hand('left', 'fist'), hand('right', 'fist')]],
    [1500, [hand('left', 'fist'), hand('right', 'fist')]],
    [20, [hand('left', 'open'), hand('right', 'open')]],
  ]);
  assert.equal(timeout.mode, 'MOVE');
  assert.equal(timeout.toggle.state, 'IDLE');

  const lost = runToggle([
    [0, [hand('left', 'fist'), hand('right', 'fist')]],
    [160, [hand('left', 'fist'), hand('right', 'fist')]],
    [20, [hand('left', 'fist')]],
    [20, [hand('left', 'open'), hand('right', 'open')]],
  ]);
  assert.equal(lost.mode, 'MOVE');
});

test('opening an open palm engages after 150 ms and captures the center; a fist stops movement', () => {
  const g = new Gestures();
  const intents = () => g.apply({ move: { forward: 0, strafe: 0, vertical: 0 }, turn: 0, toggles: {} });

  g.setFrame([hand('right', 'open', { x: 0.5, y: 0.5, scale: 0.12 })], 0);
  g.setFrame([hand('right', 'open', { x: 0.5, y: 0.5, scale: 0.12 })], 140);
  assert.equal(g.joy.engaged, false);
  assert.equal(intents().move.forward, 0);

  g.setFrame([hand('right', 'open', { x: 0.5, y: 0.5, scale: 0.12 })], 160);
  assert.equal(g.joy.engaged, true);
  assert.ok(Math.abs(g.joy.center.x - 0.5) < 1e-9);

  g.setFrame([hand('right', 'open', { x: 0.5, y: 0.5, scale: 0.12 * Math.exp(g.cfg.FULL_DEPTH) })], 180);
  const pushed = intents();
  assert.ok(pushed.move.forward > 0.9, `forward ${pushed.move.forward}`);

  g.setFrame([hand('right', 'open', { x: 0.5, y: 0.5, scale: 0.12 })], 200);
  assert.ok(Math.abs(intents().move.forward) < 0.05, 'back at center stops');

  g.setFrame([hand('right', 'fist')], 220);
  assert.equal(g.move.engaged, false);
  assert.ok(Math.abs(intents().move.forward) < 1e-6, 'a fist zeros that stick immediately');
});

test('right hand strafes and does not look; left hand looks and does not move', () => {
  const g = new Gestures();
  const fullX = 0.5 + g.cfg.FULL_LATERAL * 0.12;
  g.setFrame([hand('right', 'open', { x: 0.5, y: 0.5, scale: 0.12 })], 0);
  g.setFrame([hand('right', 'open', { x: 0.5, y: 0.5, scale: 0.12 })], 160);
  g.setFrame([hand('right', 'open', { x: fullX, y: 0.5, scale: 0.12 })], 180);
  let i = g.apply({ move: { forward: 0, strafe: 0, vertical: 0 }, turn: 0, pitch: 0, toggles: {} });
  assert.ok(i.move.strafe > 0.9, 'right hand left/right is strafe');
  assert.equal(i.turn, 0);
  assert.equal(i.pitch, 0);

  const look = new Gestures();
  const fullY = 0.5 - look.cfg.FULL_LOOK_VERTICAL * 0.12;
  const fullLookX = 0.5 + look.cfg.FULL_LOOK_LATERAL * 0.12;
  look.setFrame([hand('left', 'open', { x: 0.5, y: 0.5, scale: 0.12 })], 0);
  look.setFrame([hand('left', 'open', { x: 0.5, y: 0.5, scale: 0.12 })], 160);
  look.setFrame([hand('left', 'open', { x: fullLookX, y: fullY, scale: 0.12 })], 180);
  i = look.apply({ move: { forward: 0, strafe: 0, vertical: 0 }, turn: 0, pitch: 0, toggles: {} });
  assert.ok(i.turn < -0.9, 'left hand yaws (hand right = turn right)');
  assert.ok(i.pitch > 0.9, 'left hand pitches');
  assert.equal(i.move.forward, 0);
  assert.equal(i.move.strafe, 0);
});

test('one fist recenters that stick and leaves the other engaged', () => {
  const g = new Gestures();
  const pair = (rightX = 0.5) => [
    hand('left', 'open', { x: 0.3, scale: 0.12 }),
    hand('right', 'open', { x: rightX, scale: 0.12 }),
  ];
  g.setFrame(pair(), 0);
  g.setFrame(pair(), 160);
  assert.equal(g.move.engaged && g.look.engaged, true);
  const oldMove = g.move.center.x;
  g.setFrame([hand('left', 'open', { x: 0.3, scale: 0.12 }), hand('right', 'fist')], 180);
  assert.equal(g.move.engaged, false);
  assert.equal(g.look.engaged, true);
  g.setFrame([hand('left', 'open', { x: 0.3, scale: 0.12 }), hand('right', 'open', { x: 0.7, scale: 0.12 })], 200);
  g.setFrame([hand('left', 'open', { x: 0.3, scale: 0.12 }), hand('right', 'open', { x: 0.7, scale: 0.12 })], 360);
  assert.equal(g.move.engaged, true);
  assert.ok(Math.abs(g.move.center.x - 0.7) < 1e-9, 'right stick recaptured a new center');
  assert.ok(Math.abs(oldMove - 0.5) < 1e-9);
});

test('pinch in MOVE does nothing; an open palm in EDIT does nothing', () => {
  const g = new Gestures();
  g.setFrame([hand('right', 'pinch', { scale: 0.2 })], 0);
  g.setFrame([hand('right', 'pinch', { scale: 0.3 })], 200);
  assert.equal(g.joy.engaged, false);
  assert.equal(g.apply({ move: { forward: 0, strafe: 0, vertical: 0 }, turn: 0, toggles: {} }).move.forward, 0);

  g.mode = 'EDIT';
  g.setFrame([hand('right', 'open', { x: 0.5, y: 0.5, scale: 0.12 })], 0);
  g.setFrame([hand('right', 'open', { x: 0.5, y: 0.5, scale: 0.2 })], 200);
  assert.equal(g.joy.engaged, false);
  assert.equal(g.apply({ move: { forward: 0, strafe: 0, vertical: 0 }, turn: 0, toggles: {} }).move.forward, 0);
});

test('both open: right moves, left looks; toggleMode flips and disengages', () => {
  const g = new Gestures();
  g.setFrame([hand('left', 'open', { x: 0.2, scale: 0.12 }), hand('right', 'open', { x: 0.8, scale: 0.12 })], 0);
  g.setFrame([hand('left', 'open', { x: 0.2, scale: 0.12 }), hand('right', 'open', { x: 0.8, scale: 0.12 })], 160);
  assert.equal(g.move.engaged, true);
  assert.equal(g.look.engaged, true);
  assert.ok(Math.abs(g.move.center.x - 0.8) < 1e-9);
  assert.ok(Math.abs(g.look.center.x - 0.2) < 1e-9);
  g.toggleMode();
  assert.equal(g.mode, 'EDIT');
  assert.equal(g.joy.engaged, false);
});

test('lost hand or low confidence disengages; apply merges onto keyboard intents', () => {
  const g = new Gestures();
  g.setFrame([hand('right', 'open', { scale: 0.12 })], 0);
  g.setFrame([hand('right', 'open', { scale: 0.12 })], 160);
  g.setFrame([hand('right', 'open', { scale: 0.12 * Math.exp(g.cfg.FULL_DEPTH) })], 180);
  assert.ok(g.apply({ move: { forward: 0, strafe: 0, vertical: 0 }, turn: 0, toggles: {} }).move.forward > 0.5);

  g.setFrame([], 200);
  assert.equal(g.joy.engaged, false);

  const merged = g.apply({ move: { forward: 0.4, strafe: 0, vertical: 0 }, turn: 0, toggles: {} });
  assert.ok(merged.move.forward >= 0.4, 'keyboard still works while decaying');
});

test('right hand raise/lower flies up/down alongside forward and strafe (3 axes)', () => {
  const g = new Gestures();
  const at = (x, y, scale) => [hand('right', 'open', { x, y, scale })];
  g.setFrame(at(0.5, 0.5, 0.12), 0);
  g.setFrame(at(0.5, 0.5, 0.12), 160);
  const fresh = () => ({ move: { forward: 0, strafe: 0, vertical: 0 }, turn: 0, pitch: 0, toggles: {} });
  g.setFrame(at(0.5, 0.5 - g.cfg.FULL_VERTICAL * 0.12, 0.12), 180);
  assert.ok(g.apply(fresh()).move.vertical > 0.9, 'raise = up');
  g.setFrame(at(0.5, 0.5 + g.cfg.FULL_VERTICAL * 0.12, 0.12), 200);
  assert.ok(g.apply(fresh()).move.vertical < -0.9, 'lower = down');
  g.setFrame(at(0.5 + g.cfg.FULL_LATERAL * 0.12, 0.5 - g.cfg.FULL_VERTICAL * 0.12, 0.12 * Math.exp(g.cfg.FULL_DEPTH)), 220);
  const i = g.apply(fresh());
  assert.ok(i.move.vertical > 0 && i.move.strafe > 0 && i.move.forward > 0, 'all three at once');
  g.setFrame([hand('right', 'fist')], 240);
  assert.equal(g.apply(fresh()).move.vertical, 0);
});
