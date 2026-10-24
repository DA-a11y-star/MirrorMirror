import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';

// Node doesn't consume the browser import map; resolve the same vendored module for these headless tests.
async function load(name) {
  const path = new URL(`../web/${name}.js`, import.meta.url);
  const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
  const source = (await readFile(path, 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
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
