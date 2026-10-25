import assert from 'node:assert/strict';
import { test } from 'node:test';
import { excess, GAZE_LOOK, GazeLook } from '../web/gaze-look.js';

const fresh = (extra = {}) => new GazeLook({ ...GAZE_LOOK, ...extra });
const at = (x, y, conf = 1) => ({ x, y, conf });
// Hold a gaze for `seconds` at `hz`, returning the total turn (radians).
function hold(look, gaze, seconds, hz = 60, enabled = true) {
  const total = { dYaw: 0, dPitch: 0 };
  for (let t = 0; t < seconds - 1e-9; t += 1 / hz) {
    const r = look.update(gaze, 1 / hz, enabled);
    total.dYaw += r.dYaw;
    total.dPitch += r.dPitch;
  }
  return total;
}

test('looking at the middle of the screen, or anywhere inside the dead zone, never turns the view', () => {
  for (const gaze of [at(0.5, 0.5), at(0.7, 0.5), at(0.3, 0.5), at(0.5, 0.7), at(0.5, 0.3), at(0.72, 0.3)]) {
    assert.deepEqual(hold(fresh(), gaze, 3), { dYaw: 0, dPitch: 0 }, JSON.stringify(gaze));
  }
});

test('eyes at the right edge turn the view right, left turn left, up looks up, down looks down', () => {
  const right = hold(fresh(), at(0.97, 0.5), 2), left = hold(fresh(), at(0.03, 0.5), 2);
  const up = hold(fresh(), at(0.5, 0.03), 2), down = hold(fresh(), at(0.5, 0.97), 2);
  assert.ok(right.dYaw < -0.5, `right ${right.dYaw}`);       // dYaw > 0 turns left, so right is negative
  assert.ok(left.dYaw > 0.5, `left ${left.dYaw}`);
  assert.ok(up.dPitch > 0.3, `up ${up.dPitch}`);             // dPitch > 0 looks up
  assert.ok(down.dPitch < -0.3, `down ${down.dPitch}`);
  assert.equal(right.dPitch, 0, 'a purely horizontal gaze does not tilt the view');
  assert.equal(up.dYaw, 0, 'a purely vertical gaze does not swing the view');
});

test('a glance does nothing: the gaze must rest outside the dead zone, and the turn eases in', () => {
  const look = fresh();
  assert.deepEqual(look.update(at(0.97, 0.5), 0.1), { dYaw: 0, dPitch: 0 }, '100 ms in: still dwelling');
  assert.deepEqual(look.update(at(0.97, 0.5), 0.1), { dYaw: 0, dPitch: 0 }, '200 ms in: still dwelling');
  const first = look.update(at(0.97, 0.5), 0.1).dYaw;
  const later = hold(look, at(0.97, 0.5), 1).dYaw / 60;
  assert.ok(first < 0 && Math.abs(first) < Math.abs(later), 'the first turning frame is gentler than full rate');
  // Looking away and back restarts the dwell.
  look.update(at(0.5, 0.5), 0.1);
  assert.deepEqual(look.update(at(0.97, 0.5), 0.1), { dYaw: 0, dPitch: 0 }, 'back at the edge: dwelling again');
});

test('the turn grows toward the edge, and speed scales it', () => {
  const near = hold(fresh(), at(0.82, 0.5), 2).dYaw, far = hold(fresh(), at(0.99, 0.5), 2).dYaw;
  assert.ok(near < 0 && far < near, `further out turns faster (${near} then ${far})`);
  const slow = hold(fresh({ SPEED: 0.5 }), at(0.97, 0.5), 2).dYaw, fast = hold(fresh({ SPEED: 1 }), at(0.97, 0.5), 2).dYaw;
  assert.ok(Math.abs(Math.abs(fast) / Math.abs(slow) - 2) < 1e-9, 'half the speed, half the turn');
});

test('no gaze, low confidence, bad numbers, a disabled switch or a held block all mean no turning, and reset the dwell', () => {
  for (const [gaze, enabled, cfg] of [[null, true, {}], [at(0.97, 0.5, 0.2), true, {}], [at(NaN, 0.5), true, {}], [at(0.97, 0.5), false, {}], [at(0.97, 0.5), true, { ENABLED: false }]]) {
    assert.deepEqual(hold(fresh(cfg), gaze, 3, 60, enabled), { dYaw: 0, dPitch: 0 }, JSON.stringify([gaze, enabled, cfg]));
  }
  const look = fresh();
  hold(look, at(0.97, 0.5), 1);
  look.update(null, 0.016);
  assert.deepEqual(look.update(at(0.97, 0.5), 0.1), { dYaw: 0, dPitch: 0 }, 'losing the gaze restarts the dwell');
});

test('the turn per second does not depend on the frame rate', () => {
  const slow = hold(fresh(), at(0.95, 0.5), 3, 20).dYaw, fast = hold(fresh(), at(0.95, 0.5), 3, 120).dYaw;
  assert.ok(Math.abs(slow / fast - 1) < 0.05, `${slow} vs ${fast}`);
});

test('excess is 0 in the dead zone and 1 at the edge', () => {
  assert.equal(excess(0.5, 0.55), 0);
  assert.equal(excess(-0.55, 0.55), 0);
  assert.equal(excess(1, 0.55), 1);
  assert.equal(excess(-1.4, 0.55), 1, 'beyond the edge is capped');
  assert.ok(Math.abs(excess(0.775, 0.55) - 0.5) < 1e-9);
});
