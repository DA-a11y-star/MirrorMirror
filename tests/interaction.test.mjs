import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { load } from './load.mjs';

const { Interaction } = await load('interaction');
const { Hands } = await load('hands');

// One 1 m block at x = 0, or several side by side at the given x positions. Each step advances a fake clock.
// `eyeShift` moves the viewer's eye view sideways from the base camera, as the depth effect does with the head.
function setup(xs = [0], { eyeShift = 0 } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, .05, 100);
  camera.position.set(0, .5, 0);
  camera.updateMatrixWorld();
  const group = new THREE.Group();
  scene.add(group);
  const blocks = xs.map((x, i) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.position.set(x, .5, -3);
    mesh.userData.id = `b${i + 1}`;
    group.add(mesh);
    return mesh;
  });
  const hands = new Hands(scene);
  const learned = [];
  const eye = camera.clone();
  eye.position.x += eyeShift;
  eye.updateMatrixWorld();
  const interaction = new Interaction(group, camera, hands, eye, { onLearn: sample => learned.push(sample) });
  const gaze = { x: .5, y: .5, conf: 1 };
  const clock = { now: 0 };
  function step(handList, point = gaze, enabled = true, dt = 100) {
    clock.now += dt;
    hands.setFrame(handList);
    hands.update(1, camera);
    interaction.setFrame({ hands: handList });
    interaction.update(point, enabled, clock.now);
  }
  // Frames of steady gaze, long enough to acquire a target and to count as a supported dwell.
  const look = (point = gaze, frames = 4) => { for (let i = 0; i < frames; i++) step([], point); };
  return { block: blocks[0], blocks, hands, interaction, step, look, gaze, learned, clock };
}
function hand(pinching, x = 0, side = 'right', held = false) {
  return { side, pinching, pinch: pinching ? 1 : 0, held, lm: Array.from({ length: 21 }, () => [x, 0, .45]) };
}
const point = ([x, y]) => ({ x, y, conf: 1 });
const center = r => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
const above = (r, gap) => [(r.x0 + r.x1) / 2, r.y0 - gap];
const FAR = point([.97, .97]);

test('gaze highlights a block and restores its base material when gaze disappears', () => {
  const s = setup();
  s.step([]);
  assert.equal(s.interaction.target, null, 'a passing glance is not enough: the highlight needs a short dwell');
  s.step([]);
  assert.equal(s.interaction.target, s.block);
  assert.notEqual(s.block.material.emissive.getHex(), 0);
  s.step([], null);
  assert.equal(s.interaction.target, s.block, 'a blink keeps the target for a grace period');
  s.step([], null, true, 400);
  assert.equal(s.interaction.target, null);
  assert.equal(s.block.material.emissive.getHex(), 0);
});

test('pinch preserves object offset, moves it, then releases without a snap', () => {
  const s = setup();
  const initial = s.block.position.clone();
  s.step([hand(false)]);
  s.step([hand(true)]);
  assert.ok(s.block.position.distanceTo(initial) < 1e-10);
  assert.equal(s.interaction.grabs.size, 1);
  s.step([hand(true, .1)], null); // looking away does not drop a held object
  assert.ok(s.block.position.x > .1);
  const moved = s.block.position.clone();
  s.step([hand(false, .2)], null);
  assert.equal(s.interaction.grabs.size, 0);
  assert.ok(s.block.position.distanceTo(moved) < 1e-10);
});

test('held tracking pose freezes motion, sustained loss releases', () => {
  const s = setup();
  s.look();
  s.step([hand(true)]);
  const original = s.block.position.clone();
  s.step([hand(true, .3, 'right', true)]);
  assert.ok(s.block.position.distanceTo(original) < 1e-10);
  assert.equal(s.interaction.grabs.size, 1);
  s.step([], null);
  assert.equal(s.interaction.grabs.size, 0);
});

test('a fast carry survives a momentary open-pinch reading, but a sustained one still releases', () => {
  const s = setup();
  s.look();
  let t = 0;
  const moving = (pinching, x) => ({ ...hand(pinching, x), t: (t += .05) });
  s.step([moving(true, 0)]);
  assert.equal(s.interaction.grabs.size, 1);
  for (let x = .1; x < .5; x += .1) s.step([moving(true, x)]); // ~2 m/s
  s.step([moving(false, .5)]); // blur makes the pinch read open for one frame
  assert.equal(s.interaction.grabs.size, 1, 'a one-frame flicker during a fast carry keeps the grab');
  s.step([moving(true, .6)]);
  assert.equal(s.interaction.grabs.size, 1);
  assert.equal(s.interaction.grabs.get('right').openSince, null, 'a returning pinch cancels the pending release');
  for (let x = .7; x < 1.2; x += .1) s.step([moving(false, x)]); // open for 400 ms: still inside the grace
  assert.equal(s.interaction.grabs.size, 1);
  s.step([moving(false, 1.2)]);
  s.step([moving(false, 1.3)]);
  assert.equal(s.interaction.grabs.size, 0, 'an open pinch that persists is a real release');
  assert.match(s.interaction.lastEnd, /pinch opened/);
});

// A fast carry (~2 m/s), then returns the block position at the last frame the pinch was still closed.
function fastCarry() {
  const s = setup();
  s.look();
  let t = 0;
  const moving = (pinching, x) => ({ ...hand(pinching, x), t: (t += .05) });
  s.step([moving(true, 0)]);
  for (let x = .1; x < .5; x += .1) s.step([moving(true, x)]);
  assert.equal(s.interaction.grabs.size, 1);
  return { ...s, moving, closed: s.block.position.clone() };
}

test('after a fast carry stops and the fingers open, the block stays put through the grace and the release', () => {
  const s = fastCarry();
  for (let i = 0; i < 5; i++) { // the hand drifts while open; the block must not follow it
    s.step([s.moving(false, .5 - i * .05)]);
    assert.equal(s.interaction.grabs.size, 1, 'still inside the grace');
    assert.ok(s.block.position.distanceTo(s.closed) < 1e-10, `block moved during the grace at step ${i}`);
  }
  s.step([s.moving(false, .2)]);
  assert.equal(s.interaction.grabs.size, 0);
  assert.ok(s.block.position.distanceTo(s.closed) < 1e-10, 'release does not move the block');
});

test('letting go mid-swing does not move the block after the open, even though the hand keeps moving', () => {
  const s = fastCarry();
  for (let x = .5; x < 1; x += .1) { // hand keeps travelling at ~2 m/s with the fingers open
    s.step([s.moving(false, x)]);
    assert.ok(s.block.position.distanceTo(s.closed) < 1e-10, `block followed the open hand to x=${x.toFixed(1)}`);
  }
});

test('a one-frame flicker keeps the grip, does not jump the block, and following resumes', () => {
  const s = fastCarry();
  s.step([s.moving(false, .5)]); // pinch reads open for one frame
  assert.ok(s.block.position.distanceTo(s.closed) < 1e-10);
  s.step([s.moving(true, .6)]); // pinch returns with the hand 0.2 further along
  assert.equal(s.interaction.grabs.size, 1);
  assert.equal(s.interaction.grabs.get('right').openSince, null);
  assert.ok(s.block.position.distanceTo(s.closed) < 1e-10, 'no jump on the frame the pinch returns');
  s.step([s.moving(true, .7)]);
  const advance = s.block.position.x - s.closed.x;
  assert.ok(advance > .2 && advance < 1.5, `block follows the hand again (moved ${advance.toFixed(2)} m)`);
});

test('a fast carry that loses the hand entirely still releases right away', () => {
  const s = setup();
  s.look();
  let t = 0;
  const moving = x => ({ ...hand(true, x), t: (t += .05) });
  s.step([moving(0)]);
  for (let x = .1; x < .5; x += .1) s.step([moving(x)]);
  assert.equal(s.interaction.grabs.size, 1);
  s.step([], null);
  assert.equal(s.interaction.grabs.size, 0);
  assert.match(s.interaction.lastEnd, /hand lost/);
});

test('a pinch without a target cannot grab later until released', () => {
  const s = setup();
  s.step([hand(true)], null);
  s.step([hand(true)]);
  s.step([hand(true)]);
  assert.equal(s.interaction.target, s.block);
  assert.equal(s.interaction.grabs.size, 0);
  s.step([hand(false)]);
  s.step([hand(true)]);
  assert.equal(s.interaction.grabs.size, 1);
});

test('calibration/mode switching releases and consumes an already-held pinch', () => {
  const s = setup();
  s.look();
  s.step([hand(true)]);
  assert.equal(s.interaction.grabs.size, 1);
  s.interaction.releaseAll();
  s.step([hand(true)]);
  s.step([hand(true)]); // the target is back while the same pinch continues
  assert.equal(s.interaction.target, s.block);
  assert.equal(s.interaction.grabs.size, 0);
  s.step([hand(false)], s.gaze, false);
  s.step([hand(true)], s.gaze, false);
  s.step([hand(true)]);
  s.step([hand(true)]);
  assert.equal(s.interaction.grabs.size, 0);
});

test('two hands cannot independently own the same block', () => {
  const s = setup();
  s.look();
  s.step([hand(true, 0, 'left'), hand(true)]);
  assert.equal(s.interaction.grabs.size, 1);
});

test('targets snap to a block outline and stick through gaze drift', () => {
  const s = setup();
  const r = s.interaction.screenRect(s.block);
  s.look(point(above(r, .17)));
  assert.equal(s.interaction.target, null, 'too far from the outline to snap');
  s.look(point(above(r, .1)));
  assert.equal(s.interaction.target, s.block, 'a near miss snaps to the block');
  s.step([], point(above(r, .17)));
  s.step([], point(above(r, .17)), true, 600);
  assert.equal(s.interaction.target, s.block, 'drift beyond the snap radius but inside the sticky radius keeps it');
  s.step([], FAR);
  assert.equal(s.interaction.target, s.block, 'looking away is held briefly, e.g. a glance at your hand');
  s.step([], FAR, true, 400);
  assert.equal(s.interaction.target, null);
});

test('a blink or glance away still lets a pinch grab, but not once the grace period passes', () => {
  const s = setup();
  s.look();
  s.step([hand(false)], null);
  s.step([hand(true)], null);
  assert.equal(s.interaction.grabs.size, 1);

  const late = setup();
  late.look();
  late.step([hand(false)], null);
  late.step([hand(false)], null, true, 400);
  late.step([hand(true)], null);
  assert.equal(late.interaction.grabs.size, 0);
});

test('targeting follows the viewer\'s eye view, not the base camera', () => {
  const s = setup([0], { eyeShift: 1.2 });
  const r = s.interaction.screenRect(s.block);
  assert.ok(r.x1 < .4, 'seen from the shifted eye, the block sits left of centre');
  s.look(point([.5, .5])); // where the block would be if the base camera were the viewer
  assert.equal(s.interaction.target, null);
  s.look(point(center(r)));
  assert.equal(s.interaction.target, s.block);
});

test('a challenger needs a clear margin and a short delay to take the target', () => {
  const s = setup([-.9, .9]);
  const [a, b] = s.blocks;
  const ra = s.interaction.screenRect(a);
  const rb = s.interaction.screenRect(b);
  assert.ok(rb.x0 - ra.x1 > .1, 'blocks sit apart on screen');
  const y = center(ra)[1];
  s.look(point(center(ra)));
  assert.equal(s.interaction.target, a);

  s.look(point([ra.x1 + (rb.x0 - ra.x1) * .55, y]), 6);
  assert.equal(s.interaction.target, a, 'slightly closer to the other block is not close enough to switch');

  const nearB = point([ra.x1 + (rb.x0 - ra.x1) * .75, y]);
  s.step([], nearB);
  assert.equal(s.interaction.target, a);
  s.step([], point(center(ra))); // looking back cancels the challenge
  s.step([], nearB);
  s.step([], nearB);
  assert.equal(s.interaction.target, a, 'only 100 ms since the challenge restarted');
  s.step([], nearB);
  assert.equal(s.interaction.target, b);
});

test('a grab held after a supported dwell reports a calibration sample once', () => {
  const s = setup();
  s.look();
  s.step([hand(true)]);
  const startedAt = s.clock.now;
  for (let i = 0; i < 4; i++) s.step([hand(true)]);
  assert.equal(s.learned.length, 0, 'not yet: 400 ms of holding');
  s.step([hand(true)]);
  assert.equal(s.learned.length, 1);
  const sample = s.learned[0];
  assert.equal(sample.at, startedAt);
  assert.equal(sample.now, s.clock.now);
  assert.equal(sample.aspect, 1);
  const outline = s.interaction.screenRect(s.block);
  assert.ok(sample.rect.x0 > outline.x0 && sample.rect.x1 < outline.x1 && sample.rect.y0 > outline.y0 && sample.rect.y1 < outline.y1,
    'the learning target is inside the block outline');
  s.step([hand(true)]);
  s.step([hand(true)]);
  assert.equal(s.learned.length, 1);
});

test('calibration learns nothing from a wrong grab, a rushed grab or an unsupported target', () => {
  const quick = setup();
  quick.look(quick.gaze, 3);
  for (let i = 0; i < 8; i++) quick.step([hand(i < 3)]); // released before the confirmation time
  assert.equal(quick.learned.length, 0);

  const rushed = setup();
  rushed.look(rushed.gaze, 2);
  rushed.step([hand(true)]); // target acquired only 100 ms earlier
  for (let i = 0; i < 8; i++) rushed.step([hand(true)]);
  assert.equal(rushed.interaction.grabs.size, 1);
  assert.equal(rushed.learned.length, 0);

  const glance = setup();
  glance.look();
  glance.step([hand(false)], null);
  for (let i = 0; i < 8; i++) glance.step([hand(true)], null); // the pinch started on a target the gaze no longer supported
  assert.equal(glance.interaction.grabs.size, 1);
  assert.equal(glance.learned.length, 0);
});

test('a block another user is holding cannot be targeted or grabbed until they let go', () => {
  const s = setup();
  s.interaction.setRemote(new Set(['b1']), new Set());
  s.look();
  assert.equal(s.interaction.target, null);
  s.step([hand(false)]);
  s.step([hand(true)]);
  assert.equal(s.interaction.grabs.size, 0);
  s.step([hand(false)]);
  s.interaction.setRemote(new Set(), new Set());
  s.look();
  assert.equal(s.interaction.target, s.block);
});

test('a target another user takes is dropped at once, without the blink grace period', () => {
  const s = setup();
  s.look();
  assert.equal(s.interaction.target, s.block);
  s.interaction.setRemote(new Set(['b1']), new Set());
  s.step([]); // still looking straight at it
  assert.equal(s.interaction.target, null);
});

test('drop lets go of only that block, and the pinch stays consumed until released', () => {
  const s = setup([-.8, .8]);
  const first = point(center(s.interaction.screenRect(s.blocks[0])));
  s.look(first);
  s.step([hand(true)], first);
  assert.equal(s.interaction.grabs.size, 1);
  const start = s.blocks[0].position.clone();
  s.interaction.drop('b2');
  assert.equal(s.interaction.grabs.size, 1, 'a different block id changes nothing');
  s.interaction.drop('b1');
  assert.equal(s.interaction.grabs.size, 0);
  s.step([hand(true, .1)], first);
  assert.equal(s.interaction.grabs.size, 0, 'still pinching: no instant regrab');
  assert.ok(s.blocks[0].position.distanceTo(start) < 1e-10, 'and the block does not follow the hand');
  s.step([hand(false)], first);
  s.step([hand(true)], first);
  assert.equal(s.interaction.grabs.size, 1);
});

test('blocks other users look at or hold glow violet, below the local highlights', () => {
  const s = setup();
  const base = s.block.material.emissive.getHex();
  s.interaction.setRemote(new Set(), new Set(['b1']));
  s.step([], null);
  assert.equal(s.block.material.emissive.getHex(), 0x8f7cf0);
  const looking = s.block.material.emissiveIntensity;
  s.interaction.setRemote(new Set(['b1']), new Set(['b1']));
  s.step([], null);
  assert.ok(s.block.material.emissiveIntensity > looking, 'holding glows brighter than looking');
  s.interaction.setRemote(new Set(), new Set(['b1']));
  s.look();
  assert.equal(s.block.material.emissive.getHex(), 0xf4c95d, 'our own gaze target wins');
  s.interaction.setRemote(new Set(), new Set());
  s.step([], null);
  s.step([], null, true, 400); // the local target outlives a blink by the grace period, then everything clears
  assert.equal(s.block.material.emissive.getHex(), base);
});

// ---- two-hand scaling ----
// The right hand grabs the block, then the left hand pinches (new pinch) and moves away or toward it.
function holdThenScale(s, leftStart = -.1) {
  s.look();
  s.step([hand(false, 0, 'right')]);
  s.step([hand(true, 0, 'right')]);
  assert.equal(s.interaction.grabs.size, 1);
  s.step([hand(true, 0, 'right'), hand(false, leftStart, 'left')]);
  s.step([hand(true, 0, 'right'), hand(true, leftStart, 'left')]);
}
const settle = (s, leftX, frames = 12) => { for (let i = 0; i < frames; i++) s.step([hand(true, 0, 'right'), hand(true, leftX, 'left')]); };

test('scaling: a second pinch while one hand holds starts it, and spreading the hands grows the block uniformly', () => {
  const s = setup();
  holdThenScale(s);
  const grab = [...s.interaction.grabs.values()][0];
  assert.ok(grab.scaling, 'the second hand\'s pinch put the grab into scale mode');
  assert.equal(s.interaction.grabs.size, 1, 'still one grab: the second hand does not own the block');
  settle(s, -.3);
  const grown = s.block.scale.clone();
  assert.ok(grown.x > 1.5, `spreading made it bigger (${grown.x})`);
  assert.ok(Math.abs(grown.x - grown.y) < 1e-9 && Math.abs(grown.y - grown.z) < 1e-9, 'uniformly');
  settle(s, -.05, 20);
  assert.ok(s.block.scale.x < grown.x, 'closing the hands shrinks it again');
});

test('scaling: the size is limited to a fraction and a few multiples of the original, however far the hands go', () => {
  const s = setup();
  holdThenScale(s);
  settle(s, -3, 30);
  assert.ok(s.block.scale.x <= 4 + 1e-6 && s.block.scale.x > 3.5, `capped at 4x (${s.block.scale.x})`);
  settle(s, -.0001, 40);
  assert.ok(s.block.scale.x >= .3 - 1e-6 && s.block.scale.x < .35, `floored at 0.3x (${s.block.scale.x})`);
});

test('scaling: letting go with the second hand keeps the size and the block stays held; a new second pinch carries on from there', () => {
  const s = setup();
  holdThenScale(s);
  settle(s, -.3);
  const size = s.block.scale.x;
  s.step([hand(true, 0, 'right'), hand(false, -.3, 'left')]);
  assert.equal([...s.interaction.grabs.values()][0].scaling, null, 'scale mode ended');
  assert.equal(s.interaction.grabs.size, 1, 'the first hand still holds the block');
  s.step([hand(true, .05, 'right'), hand(false, -.3, 'left')]);
  assert.equal(s.block.scale.x, size, 'the size stays');
  assert.ok(s.block.position.x > 0, 'and the holding hand still moves the block');
  const hold = x => s.step([hand(true, .05, 'right'), hand(true, x, 'left')]);
  hold(-.15);
  for (let i = 0; i < 12; i++) hold(-.15);
  assert.ok(Math.abs(s.block.scale.x - size) < .05, `a new pinch starts from the current size, not the original (${s.block.scale.x} vs ${size})`);
});

test('scaling: a second pinch aimed at a different block grabs that one instead of scaling', () => {
  const s = setup([-1.2, 1.2]);
  const [left, right] = s.blocks;
  const rectOf = mesh => s.interaction.screenRect(mesh);
  s.look(point(center(rectOf(left))));
  s.step([hand(false, 0, 'right')], point(center(rectOf(left))));
  s.step([hand(true, 0, 'right')], point(center(rectOf(left))));
  assert.equal(s.interaction.grabs.get('right').mesh, left);
  for (let i = 0; i < 6; i++) s.step([hand(true, 0, 'right')], point(center(rectOf(right)))); // look at the other block while holding
  s.step([hand(true, 0, 'right'), hand(false, -.2, 'left')], point(center(rectOf(right))));
  s.step([hand(true, 0, 'right'), hand(true, -.2, 'left')], point(center(rectOf(right))));
  assert.equal(s.interaction.grabs.size, 2, 'each hand holds its own block');
  assert.equal(s.interaction.grabs.get('left').mesh, right);
  assert.equal(left.scale.x, 1);
  assert.equal(right.scale.x, 1);
});

test('scaling: both hands pinching at the same moment (a double pinch) grab with one and scale with the other', () => {
  const s = setup();
  s.look();
  s.step([hand(false, 0, 'right'), hand(false, -.1, 'left')]);
  s.step([hand(true, 0, 'right'), hand(true, -.1, 'left')]);
  assert.equal(s.interaction.grabs.size, 1, 'one hand owns the block');
  assert.ok([...s.interaction.grabs.values()][0].scaling, 'and the other is already scaling it');
  settle(s, -.3);
  assert.ok(s.block.scale.x > 1.5, `spreading grows it (${s.block.scale.x})`);
});

test('scaling: hands that were already pinching before the block was targeted never scale anything', () => {
  const s = setup();
  s.step([hand(true, 0, 'right'), hand(true, -.1, 'left')]); // no gaze target yet: both pinches are consumed
  settle(s, -.1, 4); // the gaze settles on the block while both stay pinched: they were not new pinches
  settle(s, -.5, 8);
  assert.equal(s.block.scale.x, 1);
  assert.equal(s.interaction.grabs.size, 0);
});

test('scaling: while scaling, the block is highlighted differently, and releasing everything clears it', () => {
  const s = setup();
  holdThenScale(s);
  const scaling = s.block.material.emissive.getHex();
  s.step([hand(true, 0, 'right'), hand(false, -.1, 'left')]);
  assert.notEqual(s.block.material.emissive.getHex(), scaling, 'the scaling tint ends with scaling');
  s.step([hand(false, 0, 'right'), hand(false, -.1, 'left')], FAR, true, 800);
  assert.equal(s.interaction.grabs.size, 0);
});
