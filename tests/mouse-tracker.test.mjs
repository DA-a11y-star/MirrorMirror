import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { validFrame } from '../web/tracker.js';

// Node doesn't consume the browser import map. Load a web module with 'three' and its relative imports resolved.
const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function load(name, imports = {}) {
  let source = (await readFile(new URL(`../web/${name}.js`, import.meta.url), 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  for (const [path, url] of Object.entries(imports)) source = source.replaceAll(`from './${path}.js'`, `from '${url}'`);
  return { source, module: await import(dataUrl(source)), url: dataUrl(source) };
}
const hands = await load('hands');
const mock = await load('mock');
const { MousePointer, mouseFrame } = (await load('mouse-tracker', { hands: hands.url, mock: mock.url })).module;
const { Interaction } = (await load('interaction')).module;
const { trackerToWorld, Hands } = hands.module;

const VIEW = { fov: 55, aspect: 1.6 };
const camera = () => {
  const c = new THREE.PerspectiveCamera(VIEW.fov, VIEW.aspect, .05, 100);
  c.position.set(0, .5, 0);
  c.updateMatrixWorld();
  return c;
};
const pointerAt = (x, y, down = false) => Object.assign(new MousePointer(), { x, y, inside: true, down });
const pinchPoint = lm => [0, 1, 2].map(i => (lm[4][i] + lm[8][i]) / 2);

test('the hand the mouse draws sits exactly under the cursor, wherever it is on screen', () => {
  const cam = camera();
  const out = new THREE.Vector3();
  for (const [x, y] of [[.5, .5], [.1, .1], [.9, .2], [.25, .8], [.99, .99]]) {
    const frame = mouseFrame(pointerAt(x, y), VIEW, 0);
    trackerToWorld(pinchPoint(frame.hands[0].lm), cam, out);
    const ndc = out.clone().project(cam);
    assert.ok(Math.abs((ndc.x + 1) / 2 - x) < 1e-3 && Math.abs((1 - ndc.y) / 2 - y) < 1e-3, `cursor ${x},${y} drew at ${ndc.x},${ndc.y}`);
  }
});

test('the frame is a valid tracker frame; the left button is the pinch; closing it does not move the pinch point', () => {
  const open = mouseFrame(pointerAt(.3, .6), VIEW, 1);
  const closed = mouseFrame(pointerAt(.3, .6, true), VIEW, 2);
  assert.equal(validFrame(open), true);
  assert.equal(validFrame(closed), true);
  assert.deepEqual([open.hands[0].pinching, open.hands[0].pinch, closed.hands[0].pinching, closed.hands[0].pinch], [false, 0, true, 1]);
  assert.equal(closed.hands[0].held, false);
  assert.notEqual(open.hands[0].t, closed.hands[0].t, 'every frame is a fresh observation');
  pinchPoint(open.hands[0].lm).forEach((v, i) => assert.ok(Math.abs(v - pinchPoint(closed.hands[0].lm)[i]) < 1e-3));
  assert.deepEqual(mouseFrame(new MousePointer(), VIEW, 3).hands, [], 'no hand until the cursor is over the page');
});

test('only a press on the scene pinches; leaving the page or the window lets go', () => {
  const p = new MousePointer();
  p.move(.5, .5);
  p.press(false); // a click on a panel
  assert.equal(p.down, false);
  p.press(true);
  assert.equal(p.down, true);
  p.release();
  assert.equal(p.down, false);
  p.press(true);
  p.leave(); // pointer left the page, window blurred, or the pointer was cancelled
  assert.deepEqual([p.down, p.inside], [false, false]);
  assert.equal(mouseFrame(p, VIEW, 1).hands.length, 0);
});

test('with the mouse alone: look at a block, press to grab, drag to move it, release to drop it', () => {
  const cam = camera();
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  const block = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  block.position.set(0, .5, -3);
  block.userData.id = 'b1';
  group.add(block);
  const h = new Hands(scene);
  const interaction = new Interaction(group, cam, h, cam, {});
  const pointer = pointerAt(.5, .5);
  let now = 0, t = 0;
  const step = (x = pointer.x, y = pointer.y) => {
    pointer.move(x, y);
    now += 33;
    const frame = mouseFrame(pointer, VIEW, (t += .033));
    h.setFrame(frame.hands);
    h.update(1, cam);
    interaction.setFrame(frame);
    interaction.update({ x: pointer.x, y: pointer.y, conf: 1 }, true, now); // the pointer is the gaze
  };
  for (let i = 0; i < 6; i++) step();
  assert.equal(interaction.target, block, 'the cursor is the gaze');

  const before = block.position.clone();
  pointer.press(true);
  step();
  assert.equal(interaction.grabs.size, 1);
  assert.ok(block.position.distanceTo(before) < 1e-9, 'pressing does not jump the block');

  for (let i = 1; i <= 10; i++) step(.5 + i * .01); // drag right across 10% of the screen
  assert.ok(block.position.x > .3, `block followed the cursor right (x = ${block.position.x.toFixed(2)})`);
  assert.ok(Math.abs(block.position.y - before.y) < .15, 'a level drag stays level');

  pointer.release();
  step();
  assert.equal(interaction.grabs.size, 0);
  const dropped = block.position.clone();
  step(.2, .3);
  assert.ok(block.position.distanceTo(dropped) < 1e-9, 'a released block stays put');
});

test('tracker=mouse is a selectable source and nothing else about the config changes', async () => {
  globalThis.location = { search: '?tracker=mouse', hostname: 'localhost' };
  try {
    const config = await import('../web/config.js?mouse');
    assert.equal(config.TRACKER_SOURCE, 'mouse');
    assert.equal(config.USER_ID, 'A');
  } finally {
    delete globalThis.location;
  }
});
