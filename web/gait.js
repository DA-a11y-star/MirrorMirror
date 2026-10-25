// Procedural walking as pure functions: no three.js, no DOM, so they test without a browser.
// The avatar has no legs; two floating shoes step. The stride phase advances with distance travelled (not time), so a
// planted shoe stays planted on the floor whatever the speed.

export const STRIDE_M = 0.9; // distance the body covers while one foot completes a full cycle (stance + swing)
export const STANCE = 0.6; // fraction of the cycle a foot is planted
export const LIFT_M = 0.09; // peak height of a swing
export const FOOT_SIDE_M = 0.09; // each shoe's lateral offset from the body centre line
export const STEP_SPEED = 0.3; // m/s at which stepping reaches full size (below it the feet gather to rest)

const smooth = t => t * t * (3 - 2 * t);
const clamp01 = v => Math.max(0, Math.min(1, v));

// Advance the stride phase (in cycles) by the distance covered this frame.
export function advancePhase(phase, speed, dt) {
  return (phase + (speed * dt) / STRIDE_M) % 1;
}

// How much stepping is shown, 0 at rest to 1 at STEP_SPEED and above.
export function stepAmount(speed) {
  return smooth(clamp01(speed / STEP_SPEED));
}

// One foot at cycle position u in [0, 1): `f` is metres ahead of the body along the direction of travel, `lift` metres
// off the floor. Stance sweeps the foot backwards at exactly the ground speed (so it is planted in the world); swing
// carries it forward again along an arc.
export function footPose(u, stride = STRIDE_M, stance = STANCE, lift = LIFT_M) {
  u = ((u % 1) + 1) % 1;
  const half = (stride * stance) / 2;
  if (u < stance) return { f: half - (u / stance) * 2 * half, lift: 0 };
  const t = (u - stance) / (1 - stance);
  return { f: -half + 2 * half * smooth(t), lift: Math.sin(Math.PI * t) * lift };
}

// Body bob: lowest at each footfall (twice per cycle), never negative.
export function bobAmount(phase, amount, peak = 0.03) {
  return ((1 - Math.cos(4 * Math.PI * phase)) / 2) * peak * amount;
}
