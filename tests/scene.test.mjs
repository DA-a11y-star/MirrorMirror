import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Node doesn't consume the browser import map; resolve the same vendored module for these headless tests.
async function load(name) {
  const path = new URL(`../web/${name}.js`, import.meta.url);
  const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
  const source = (await readFile(path, 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
const { SPAWNS } = await load('scene');

// Locomotion's convention: yaw 0 faces -z, and a positive yaw turns left.
const facing = ({ yaw }) => [-Math.sin(yaw), -Math.cos(yaw)];

test('the two users spawn at opposite ends of the blocks, each looking at the other', () => {
  const { A, B } = SPAWNS;
  assert.ok(A.pos[2] > 2 && B.pos[2] < -2, 'opposite ends');
  for (const [me, other] of [[A, B], [B, A]]) {
    const toOther = [other.pos[0] - me.pos[0], other.pos[2] - me.pos[2]];
    const length = Math.hypot(...toOther);
    const [fx, fz] = facing(me);
    assert.ok((fx * toOther[0] + fz * toOther[1]) / length > .999, 'faces the other user across the blocks');
  }
  assert.equal(A.pitch, B.pitch, 'both look down at the blocks by the same amount');
});
