import * as THREE from 'three';

// Depth effect: the screen behaves like a window. The scene's base camera (orbit or avatar) defines the window:
// a rectangle at the focus distance, sized so that a head at its neutral position sees exactly the base view.
// When the head moves, the viewpoint moves with it and the projection is skewed through that same fixed
// rectangle (an off-axis frustum), so near things slide against far things while the focus plane stays put.
const NEUTRAL_DISTANCE_M = 0.55; // typical eye-to-screen distance; sets how much world motion 1 m of head motion makes
const HEAD_RANGE_M = [0.2, 1.5];
const FOLLOW_RATE = 14; // 1/s; eases ~20 Hz head updates into 60 fps motion
const LOST_AFTER_MS = 500; // no head reading for this long: drift back to the base view
const RETURN_RATE = 2.5; // 1/s
const MAX_OFFSET = { lateral: 0.35, depth: 0.5 }; // real meters of head travel that still count
const NEAR = 0.05;
const GAZE_REACH_M = 0.09; // equivalent real head travel when looking at a screen edge (0 = gaze has no effect)
const GAZE_LOST_AFTER_MS = 400;
const GAZE_RATE = 6; // 1/s; gaze is jumpier than the head, so it is smoothed harder

export function validHead(head) {
  return !!head && Array.isArray(head.pos) && head.pos.length === 3 && head.pos.every(Number.isFinite) &&
    head.pos[2] >= HEAD_RANGE_M[0] && head.pos[2] <= HEAD_RANGE_M[1];
}

// Head offset (real meters, webcam axes: x right, y down, z away) -> eye offset in the base camera's local axes
// (x right, y up, z toward the viewer = away from the screen), in world meters.
export function eyeOffset(delta, scale, out = new THREE.Vector3()) {
  const clamp = (v, limit) => Math.max(-limit, Math.min(limit, v));
  return out.set(
    clamp(delta[0], MAX_OFFSET.lateral) * scale,
    -clamp(delta[1], MAX_OFFSET.lateral) * scale,
    clamp(delta[2], MAX_OFFSET.depth) * scale,
  );
}

// Off-axis perspective through the window rectangle. `halfW`/`halfH` are the window's half size at distance
// `focus` in front of the base camera; `eye` is the viewpoint offset in the base camera's local axes.
export function offAxisProjection(out, halfW, halfH, focus, eye, far) {
  const distance = Math.max(focus + eye.z, NEAR * 4); // eye to window plane
  const k = NEAR / distance;
  return out.makePerspective((-halfW - eye.x) * k, (halfW - eye.x) * k, (halfH - eye.y) * k, (-halfH - eye.y) * k, NEAR, far);
}

export class OffAxis {
  // strength scales the effect: 0 = off, 1 = physically matched angles, >1 = exaggerated.
  constructor(base, strength = 1) {
    this.base = base;
    this.strength = strength;
    this.view = new THREE.PerspectiveCamera(base.fov, base.aspect, NEAR, base.far);
    this.eye = new THREE.Vector3(); // current eye offset, base camera local axes, world meters
    this.target = new THREE.Vector3();
    this.neutral = null; // head position that maps to the base view
    this.head = null;
    this.lastSeen = -Infinity;
    this.gazeShift = [0, 0]; // smoothed screen position of gaze, -1..1 (x right, y down)
    this.gazeTarget = null;
    this.gazeSeen = -Infinity;
    this.focus = 3.35;
    this._shift = new THREE.Vector3();
  }

  setHead(head, now) {
    if (!validHead(head)) return;
    this.head = head.pos;
    this.lastSeen = now;
    // The first good reading defines "centered"; press recenter() after shifting in your chair.
    this.neutral ??= [...head.pos];
  }

  // gaze: {x, y} in 0..1 screen coordinates, or null. Looking toward an edge leans the viewpoint that way.
  setGaze(gaze, now) {
    if (!gaze || !Number.isFinite(gaze.x) || !Number.isFinite(gaze.y)) return;
    this.gazeTarget = [gaze.x * 2 - 1, gaze.y * 2 - 1];
    this.gazeSeen = now;
  }

  recenter() {
    this.neutral = this.head ? [...this.head] : null;
  }

  get active() {
    return (this.neutral !== null || this.gazeTarget !== null) && this.strength > 0;
  }

  // Call once per frame after the base camera has been moved. Returns the camera to render and raycast with.
  update(dt, now, focus) {
    const base = this.base;
    if (Number.isFinite(focus) && focus > 0.5) this.focus = focus;

    const gazeLive = this.gazeTarget && now - this.gazeSeen < GAZE_LOST_AFTER_MS;
    const g = gazeLive ? this.gazeTarget : [0, 0];
    const gk = 1 - Math.exp(-GAZE_RATE * dt);
    this.gazeShift[0] += (g[0] - this.gazeShift[0]) * gk;
    this.gazeShift[1] += (g[1] - this.gazeShift[1]) * gk;

    const tracked = this.head && this.neutral && now - this.lastSeen < LOST_AFTER_MS;
    const delta = tracked ? this.head.map((v, i) => v - this.neutral[i]) : [0, 0, 0];
    delta[0] += this.gazeShift[0] * GAZE_REACH_M;
    delta[1] += this.gazeShift[1] * GAZE_REACH_M;
    if (tracked || gazeLive || this.gazeShift.some(v => Math.abs(v) > 1e-3)) {
      eyeOffset(delta, (this.focus / NEUTRAL_DISTANCE_M) * this.strength, this.target);
    } else {
      this.target.set(0, 0, 0);
    }
    const k = 1 - Math.exp(-(tracked || gazeLive ? FOLLOW_RATE : RETURN_RATE) * dt);
    this.eye.lerp(this.target, k);

    const halfH = this.focus * Math.tan(THREE.MathUtils.degToRad(base.fov) / 2);
    const halfW = halfH * base.aspect;
    base.updateMatrixWorld();
    const view = this.view;
    view.quaternion.copy(base.quaternion);
    // Local offset -> world: right, up and back axes of the base camera.
    this._shift.copy(this.eye).applyQuaternion(base.quaternion);
    view.position.copy(base.position).add(this._shift);
    view.fov = base.fov;
    view.aspect = base.aspect;
    view.far = base.far;
    view.updateMatrixWorld();
    offAxisProjection(view.projectionMatrix, halfW, halfH, this.focus, this.eye, base.far);
    view.projectionMatrixInverse.copy(view.projectionMatrix).invert();
    return view;
  }
}
