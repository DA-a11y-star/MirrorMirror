import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advancePhase, bobAmount, footPose, LIFT_M, STANCE, STRIDE_M, stepAmount,
} from '../web/gait.js';

test('phase advances with distance, not time, and wraps', () => {
  assert.ok(Math.abs(advancePhase(0, 1, 0.5) - 0.5 / STRIDE_M) < 1e-12);
  assert.equal(advancePhase(0.5, 0, 10), 0.5, 'standing still never advances the stride');
  assert.ok(advancePhase(0.99, 0.5, 0.5) < 0.5, 'wraps past 1');
});

test('a planted foot is stationary in the world: it slides back exactly as fast as the body moves', () => {
  const speed = 1.7;
  const dt = 1 / 120;
  let phase = 0.05;
  let bodyZ = 0;
  let prev = footPose(phase).f; // ahead of the body along travel
  let worldAt0 = null;
  while (phase < STANCE - 0.02) {
    phase = advancePhase(phase, speed, dt);
    bodyZ += speed * dt;
    const world = bodyZ + footPose(phase).f;
    worldAt0 ??= world;
    assert.ok(Math.abs(world - worldAt0) < 1e-6, `foot slid ${world - worldAt0}`);
    assert.equal(footPose(phase).lift, 0, 'no lift during stance');
  }
  assert.ok(prev > footPose(phase).f, 'the foot moved backwards relative to the body');
});

test('the swing is continuous at both ends, lifts to the peak mid swing and covers the whole stride', () => {
  const end = footPose(STANCE - 1e-9);
  const start = footPose(STANCE + 1e-9);
  assert.ok(Math.abs(end.f - start.f) < 1e-6 && start.lift < 1e-6, 'stance to swing is seamless');
  const wrapEnd = footPose(1 - 1e-9);
  const wrapStart = footPose(0);
  assert.ok(Math.abs(wrapEnd.f - wrapStart.f) < 1e-6, 'swing to stance is seamless');
  const mid = footPose((STANCE + 1) / 2);
  assert.ok(Math.abs(mid.lift - LIFT_M) < 1e-9);
  assert.ok(Math.abs(mid.f) < 1e-9, 'mid swing passes under the body');
});

test('the two feet are half a cycle apart, so one is always on the floor', () => {
  for (let u = 0; u < 1; u += 0.01) {
    const a = footPose(u);
    const b = footPose(u + 0.5);
    assert.ok(a.lift === 0 || b.lift === 0, `both feet airborne at u=${u}`);
  }
});

test('stepping fades to nothing at rest and bob never goes below the floor', () => {
  assert.equal(stepAmount(0), 0);
  assert.equal(stepAmount(5), 1);
  assert.ok(stepAmount(0.15) > 0 && stepAmount(0.15) < 1);
  for (let p = 0; p < 1; p += 0.01) {
    const b = bobAmount(p, 1);
    assert.ok(b >= 0 && b <= 0.04 + 1e-12);
  }
  assert.ok(bobAmount(0, 1) < 1e-12 && bobAmount(0.5, 1) < 1e-12, 'lowest at each footfall');
  assert.equal(bobAmount(0.25, 0), 0);
});
