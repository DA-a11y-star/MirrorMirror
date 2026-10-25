import * as THREE from 'three';

// Tracker landmarks are webcam-space meters: x to the user's right (the image is mirrored), y down, and z away
// from the webcam toward the user. Hands are drawn in front of the viewing camera, as if the screen were a window
// the user reaches into: pushing a hand toward the screen pushes it deeper into the scene.
const HAND_GAIN = 1.2; // lateral scale, webcam meters -> view meters
const HAND_DROP = 0.08; // lowers the hands a little so they sit below the line of sight
const HAND_DEPTH = 0.55; // view distance of a hand held at REF_Z from the webcam
const REF_Z = 0.45;
const DEPTH_GAIN = 1.5;

// The only tracker -> world mapping. Writes into and returns `out`.
export function trackerToWorld(p, camera, out) {
  out.set(p[0] * HAND_GAIN, -p[1] * HAND_GAIN - HAND_DROP, -(HAND_DEPTH + (REF_Z - p[2]) * DEPTH_GAIN));
  return camera.localToWorld(out);
}

// The inverse of trackerToWorld at the reference depth, in the camera's own frame: the webcam-space point at which a
// hand appears under screen point (x, y), each 0..1 from the top left. Lets the mouse stand in for a hand.
export function screenToTracker(x, y, { fov, aspect }) {
  const halfHeight = HAND_DEPTH * Math.tan(fov * Math.PI / 360);
  const lx = (2 * x - 1) * halfHeight * aspect, ly = (1 - 2 * y) * halfHeight;
  return [lx / HAND_GAIN, -(ly + HAND_DROP) / HAND_GAIN, REF_Z];
}

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const TIPS = new Set([4, 8, 12, 16, 20]);
const MAX_HANDS = 2;
const JOINT_RADIUS = 0.0085;
const BONE_RADIUS = 0.0055;
const SMOOTHING_RATE = 25; // 1/s; eases 30 Hz tracker frames into 60 fps motion
// Fast motion: the farther the drawn hand trails the tracker, the faster it catches up, so slow moves keep the
// full smoothing and fast ones don't feel rubber-banded.
const CATCHUP_GAIN = 500;  // extra 1/s per meter of lag (palm)
const MAX_RATE = 70;       // 1/s
// Latency hiding: camera + inference + transport put the tracker ~100 ms behind the real hand. During fast moves the
// target is pushed ahead along the hand's measured velocity. Slow and resting hands get no lead, so pinch precision
// and jitter are unchanged; it fades if frames stop arriving, and a held (frozen) hand is never extrapolated.
const LEAD_S = 0.05;                // how far ahead of the last tracker frame to aim
const LEAD_SPEED = [0.25, 0.7];     // palm speed (m/s) where the lead starts and reaches full strength
const MAX_LEAD_M = 0.04;            // never aim further than this from the measured landmark
const LEAD_FADE_S = 0.15;           // no new frame for this long: lead is gone
const VELOCITY_BLEND = 0.5;         // weight of the newest frame-to-frame velocity

const SKIN = { left: new THREE.Color(0xf3ede6), right: new THREE.Color(0xe9eef5) };
const PINCH_GLOW = new THREE.Color(0x4c6ef5);

export class Hands {
  constructor(scene) {
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 });
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), material, MAX_HANDS * 21);
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10), material, MAX_HANDS * BONES.length);
    for (const mesh of [this.joints, this.bones]) {
      mesh.castShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false; // instances move every frame; the base bounding sphere doesn't follow them
      scene.add(mesh);
    }
    this.slots = Array.from({ length: MAX_HANDS }, () => ({
      side: null,
      pinch: 0,
      target: Array.from({ length: 21 }, () => new THREE.Vector3()), // latest tracker landmarks
      velocity: Array.from({ length: 21 }, () => new THREE.Vector3()), // tracker space, m/s, filtered
      aim: Array.from({ length: 21 }, () => new THREE.Vector3()), // target plus the fast-motion lead
      t: null, // tracker timestamp of `target`, for velocity
      frameAt: 0, // performance.now() when `target` arrived
      smoothed: Array.from({ length: 21 }, () => new THREE.Vector3()), // eased toward target, tracker space
      shown: Array.from({ length: 21 }, () => new THREE.Vector3()), // smoothed, mapped to world
      anchor: [new THREE.Vector3(), new THREE.Vector3()], // thumb and index tips mapped through the anchor camera
      fresh: true,
    }));
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
    this._arr = [0, 0, 0];
  }

  // Called whenever a tracker frame arrives.
  setFrame(hands) {
    // Slots are keyed by side so smoothing never blends one hand into the other if the tracker reorders them.
    const assigned = [null, null];
    for (const hand of hands.slice(0, MAX_HANDS)) {
      const preferred = hand.side === 'left' ? 0 : 1;
      assigned[assigned[preferred] ? 1 - preferred : preferred] = hand;
    }
    assigned.forEach((hand, h) => {
      const slot = this.slots[h];
      if (!hand) {
        slot.side = null;
        slot.pinch = 0;
        slot.fresh = true;
        slot.t = null;
        return;
      }
      if (slot.side !== hand.side) {
        slot.fresh = true;
        slot.t = null;
      }
      slot.side = hand.side;
      slot.pinch = hand.pinch;
      // Only a genuinely new observation updates velocity; a held repeat of the last pose carries no information.
      const isNew = Number.isFinite(hand.t) && hand.t !== slot.t && !hand.held;
      const dt = isNew && slot.t !== null ? hand.t - slot.t : 0;
      const usable = dt > 0.005 && dt < 0.2;
      if (isNew || slot.t === null || !Number.isFinite(hand.t)) {
        hand.lm.forEach((p, i) => {
          const target = slot.target[i];
          if (usable) {
            this._d.set(p[0] - target.x, p[1] - target.y, p[2] - target.z).divideScalar(dt);
            slot.velocity[i].lerp(this._d, VELOCITY_BLEND);
          } else {
            slot.velocity[i].set(0, 0, 0);
          }
          target.fromArray(p);
        });
        slot.t = Number.isFinite(hand.t) ? hand.t : null;
        slot.frameAt = performance.now();
      }
    });
  }

  // slot.aim = latest landmarks pushed ahead along their velocity, only while the palm is moving fast.
  aimAhead(slot, now) {
    const speed = slot.velocity[9].length();
    const [lo, hi] = LEAD_SPEED;
    const gate = THREE.MathUtils.smoothstep(speed, lo, hi);
    const fade = Math.max(0, 1 - (now - slot.frameAt) / 1000 / LEAD_FADE_S);
    const lead = LEAD_S * gate * fade;
    for (let i = 0; i < 21; i++) {
      const offset = this._d.copy(slot.velocity[i]).multiplyScalar(lead);
      if (offset.length() > MAX_LEAD_M) offset.setLength(MAX_LEAD_M);
      slot.aim[i].copy(slot.target[i]).add(offset);
    }
  }

  // Called every render frame. Smoothing happens in tracker space and the mapping uses this frame's camera,
  // so the hands stay put relative to the view even while the camera moves.
  // `camera` places the drawn hands (they follow the viewer's eye). `anchorCamera` places the thumb and index
  // tips used for grabbing: it must not move with the head, or turning your head would drag a held block.
  update(dt, camera, anchorCamera = camera) {
    let joint = 0;
    let bone = 0;
    for (const slot of this.slots) {
      if (!slot.side) continue;
      this.aimAhead(slot, performance.now());
      const lag = slot.smoothed[9].distanceTo(slot.aim[9]);
      const k = 1 - Math.exp(-Math.min(MAX_RATE, SMOOTHING_RATE + CATCHUP_GAIN * lag) * dt);
      slot.smoothed.forEach((p, i) => (slot.fresh ? p.copy(slot.aim[i]) : p.lerp(slot.aim[i], k)));
      slot.fresh = false;
      slot.smoothed.forEach((p, i) => trackerToWorld(p.toArray(this._arr), camera, slot.shown[i]));
      [4, 8].forEach((joint, n) => trackerToWorld(slot.smoothed[joint].toArray(this._arr), anchorCamera, slot.anchor[n]));

      const skin = SKIN[slot.side] ?? SKIN.right;
      slot.shown.forEach((p, i) => {
        const r = JOINT_RADIUS * (i === 0 ? 1.4 : TIPS.has(i) ? 0.9 : 1);
        this._m.compose(p, this._q.identity(), this._s.setScalar(r));
        this.joints.setMatrixAt(joint, this._m);
        const glow = i === 4 || i === 8 ? slot.pinch : 0;
        this.joints.setColorAt(joint, this._c.copy(skin).lerp(PINCH_GLOW, glow));
        joint++;
      });
      for (const [a, b] of BONES) {
        const pa = slot.shown[a];
        const pb = slot.shown[b];
        this._d.subVectors(pb, pa);
        const length = this._d.length();
        this._q.setFromUnitVectors(this._up, this._d.divideScalar(length || 1));
        this._m.compose(this._s.addVectors(pa, pb).multiplyScalar(0.5), this._q, this._d.set(BONE_RADIUS, length, BONE_RADIUS));
        this.bones.setMatrixAt(bone, this._m);
        this.bones.setColorAt(bone, skin);
        bone++;
      }
    }
    this.joints.count = joint;
    this.bones.count = bone;
    for (const mesh of [this.joints, this.bones]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
