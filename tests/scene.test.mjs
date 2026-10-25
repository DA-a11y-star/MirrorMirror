import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load.mjs';

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
