// Camera-free alternative to the Python tracker. Emits the same messages as the protocol in
// CLAUDE.md: two swaying hands that pinch every few seconds, and the mouse position as gaze.
import * as THREE from 'three';

// A real MediaPipe open left hand (world landmarks), wrist at the origin, fingers up (-y), palm toward the webcam.
// Webcam-space meters: x to the user's right, y down, z toward the user.
const OPEN_LEFT = [
  [0.000, 0.000, 0.000], [0.010, -0.016, -0.017], [0.019, -0.038, -0.017], [0.015, -0.054, -0.026],
  [0.011, -0.077, -0.027], [0.006, -0.069, -0.005], [0.007, -0.084, -0.015], [0.016, -0.103, -0.019],
  [0.017, -0.133, -0.030], [0.000, -0.070, -0.000], [0.003, -0.090, -0.009], [0.002, -0.125, -0.011],
  [0.009, -0.154, -0.017], [-0.010, -0.071, -0.003], [-0.006, -0.089, -0.007], [-0.010, -0.119, -0.008],
  [0.000, -0.150, -0.009], [-0.017, -0.061, -0.004], [-0.021, -0.076, -0.006], [-0.023, -0.104, -0.004],
  [-0.022, -0.126, -0.009],
];
const HANDS = [
  { side: 'left', mirror: 1, home: [-0.13, 0.12, 0.45], phase: 0 },
  { side: 'right', mirror: -1, home: [0.13, 0.12, 0.45], phase: 1.7 },
];
const RATE_HZ = 30;
const PINCH_PERIOD = 3.2; // s
const PINCH_ON = 0.8;
const PINCH_OFF = 0.5;

function pinchAmount(t) {
  const u = (t % PINCH_PERIOD) / PINCH_PERIOD; // close over 0.45-0.55, hold, open over 0.85-0.95
  const ramp = (a, b) => Math.min(Math.max((u - a) / (b - a), 0), 1);
  return ramp(0.45, 0.55) - ramp(0.85, 0.95);
}

// An open hand with the thumb and index tips closed `pinch` (0..1) toward their midpoint, turned by `euler`.
// Webcam-space meters, wrist at the origin; the caller positions it. `mirror` is 1 for a left hand, -1 for a right.
export function poseHand(mirror, pinch, euler = [0, 0, 0]) {
  const pts = OPEN_LEFT.map(([x, y, z]) => new THREE.Vector3(x * mirror, y, z));

  // Pinch: thumb and index tips (and, less, the joints below them) close on their midpoint.
  const mid = pts[4].clone().add(pts[8]).multiplyScalar(0.5);
  for (const [i, w] of [[4, 1], [8, 1], [3, 0.4], [7, 0.4]]) pts[i].lerp(mid, pinch * w * 0.92);

  const turn = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...euler));
  return pts.map((p) => p.applyMatrix4(turn));
}

function posedHand(spec, t) {
  const pinch = pinchAmount(t + spec.phase);
  const pts = poseHand(spec.mirror, pinch, [
    0.25 * Math.sin(t * 0.5 + spec.phase), 0.35 * Math.sin(t * 0.6 + spec.phase), 0.2 * Math.sin(t * 0.8 + spec.phase),
  ]);
  const [hx, hy, hz] = spec.home;
  const offset = new THREE.Vector3(
    hx + 0.04 * Math.sin(t * 0.7 + spec.phase),
    hy + 0.03 * Math.sin(t * 1.1 + spec.phase),
    hz + 0.06 * Math.sin(t * 0.45 + spec.phase),
  );
  const lm = pts.map((p) => p.add(offset).toArray().map((v) => +v.toFixed(4)));
  const palm = {
    x: +(0.5 + spec.home[0] + 0.08 * Math.sin(t * 0.7 + spec.phase)).toFixed(4),
    y: +(0.5 + spec.home[1] * 0.4 + 0.04 * Math.sin(t * 1.1 + spec.phase)).toFixed(4),
    scale: +(0.12 + 0.03 * Math.sin(t * 0.45 + spec.phase)).toFixed(4),
  };
  const pose = pinch > 0.7 ? 'pinch' : 'open';
  return { side: spec.side, lm, pinch: +pinch.toFixed(3), pose, pose_conf: 0.9, palm };
}

export function startMockTracker(onMessage) {
  const gaze = { x: 0.5, y: 0.5, conf: 1.0 };
  const onPointerMove = (e) => {
    gaze.x = e.clientX / window.innerWidth;
    gaze.y = e.clientY / window.innerHeight;
  };
  window.addEventListener('pointermove', onPointerMove);

  const pinched = {};
  const t0 = performance.now();
  const timer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const hands = HANDS.map((spec) => posedHand(spec, t));
    const events = [];
    for (const hand of hands) {
      const was = pinched[hand.side] ?? false;
      const now = was ? hand.pinch > PINCH_OFF : hand.pinch > PINCH_ON;
      hand.pinching = now;
      hand.t = t;
      hand.held = false;
      if (now !== was) events.push({ type: 'gesture', name: now ? 'pinch_start' : 'pinch_end', hand: hand.side });
      pinched[hand.side] = now;
    }
    // A head swaying side to side and slightly in and out, to try the depth effect without a camera.
    const head = { pos: [0.08 * Math.sin(t * 0.8), 0.03 * Math.sin(t * 1.3), 0.6 + 0.05 * Math.sin(t * 0.5)], quat: [0, 0, 0, 1] };
    onMessage({ type: 'frame', t, hands, gaze: { ...gaze }, head });
    events.forEach(onMessage);
  }, 1000 / RATE_HZ);
  return () => {
    clearInterval(timer);
    window.removeEventListener('pointermove', onPointerMove);
  };
}
