import * as THREE from 'three';

// Targeting feel. Distances are in screen heights (1 = full viewport height); times are in milliseconds.
// Webcam gaze is only good to a few degrees, so targets snap to the nearest block outline and stick.
const SNAP_RADIUS = .14;    // gaze this close to a block's outline still targets it
const STICKY_RADIUS = .2;   // the current target survives gaze drifting this far out
const SWITCH_MARGIN = .04;  // a challenger must be this much closer than the current target
const ACQUIRE_DELAY = 80;   // the best candidate must hold this long before it is highlighted
const SWITCH_DELAY = 150;   // a challenger must keep winning this long before it replaces the target
const GRACE = 300;          // the target survives gaze loss or looking away: blinks, glancing at your hand
// A grab held this long proves the target was right; it then refines webcam calibration (see GazeCalibration.adapt).
const LEARN_HOLD = 500;
const LEARN_DWELL = 250;    // the block must have been the supported target this long before the pinch

// Gaze supplies only {x, y, conf}; interaction is independent of webcam vs hardware gaze providers.
export class Interaction {
  // `camera` is the stable base view (depth scaling for grabs); `gazeCamera` is the viewer's actual eye view,
  // which differs when the depth effect moves the viewpoint with the head. Gaze is a point on the rendered
  // screen, so targeting works in the gaze camera's view.
  constructor(blocks, camera, hands, gazeCamera = camera, { onLearn } = {}) {
    this.blocks = blocks;
    this.camera = camera;
    this.gazeCamera = gazeCamera;
    this.hands = hands;
    this.onLearn = onLearn;
    this.frame = { hands: [] };
    this.grabs = new Map();
    this.wasPinched = new Set();
    this.resetTargeting();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pinch = new THREE.Vector3();
    this.world = new THREE.Vector3();
    this.bounds = new THREE.Box3();
    this.size = new THREE.Vector3();
    this.corner = new THREE.Vector3();
    this.baseMaterials = new Map(blocks.children.map(mesh => [mesh, {
      emissive: mesh.material.emissive.clone(), intensity: mesh.material.emissiveIntensity,
    }]));
  }

  setFrame(frame) {
    this.frame = frame;
  }

  resetTargeting() {
    this.target = null;
    this.targetSince = 0;
    this.challenger = null;
    this.challengerSince = 0;
    this.lostSince = null; // set while the target is kept alive without gaze support
  }

  releaseAll() {
    this.grabs.clear();
    this.resetTargeting();
    // Switching inputs/calibrating while pinched must not grab until a new pinch starts.
    this.wasPinched = new Set(this.frame.hands.filter(h => h.pinching).map(h => h.side));
    this.highlight();
  }

  pinchPosition(side, out) {
    const slot = this.hands.slots.find(slot => slot.side === side);
    if (!slot) return null;
    const [thumb, index] = slot.anchor ?? [slot.shown[4], slot.shown[8]];
    return out.copy(thumb).add(index).multiplyScalar(.5);
  }

  // The block's outline on screen as a normalized viewport rectangle, or null if it is behind the camera.
  screenRect(mesh) {
    this.bounds.setFromObject(mesh);
    const { min, max } = this.bounds;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      this.corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).project(this.gazeCamera);
      if (this.corner.z > 1) return null;
      x0 = Math.min(x0, this.corner.x); x1 = Math.max(x1, this.corner.x);
      y0 = Math.min(y0, this.corner.y); y1 = Math.max(y1, this.corner.y);
    }
    return { x0: (x0 + 1) / 2, x1: (x1 + 1) / 2, y0: (1 - y1) / 2, y1: (1 - y0) / 2 };
  }

  // Blocks within the sticky radius of the gaze point, scored by distance (0 = the ray hits it; lower is better).
  candidates(gaze) {
    this.pointer.set(gaze.x * 2 - 1, 1 - gaze.y * 2);
    // The ray starts at the viewer's eye and passes through the gazed point on the screen.
    this.raycaster.setFromCamera(this.pointer, this.gazeCamera);
    const hit = this.raycaster.intersectObjects(this.blocks.children, false)[0]?.object ?? null;
    const found = [];
    for (const mesh of this.blocks.children) {
      const rect = this.screenRect(mesh);
      if (!rect) continue;
      const dx = Math.max(rect.x0 - gaze.x, 0, gaze.x - rect.x1) * this.gazeCamera.aspect;
      const dy = Math.max(rect.y0 - gaze.y, 0, gaze.y - rect.y1);
      // Inside a rectangle but off the visible silhouette ranks just behind a true ray hit.
      const score = mesh === hit ? 0 : .01 + Math.hypot(dx, dy);
      if (score <= STICKY_RADIUS) found.push({ mesh, score });
    }
    return found;
  }

  setTarget(mesh, now) {
    if (mesh !== this.target) {
      this.target = mesh;
      this.targetSince = now;
    }
    this.challenger = null;
    this.lostSince = null;
  }

  track(gaze, enabled, now) {
    if (!enabled) {
      this.resetTargeting();
      return;
    }
    const found = gaze && gaze.conf >= .5 ? this.candidates(gaze) : [];
    const best = found.filter(c => c.score <= SNAP_RADIUS).sort((a, b) => a.score - b.score)[0] ?? null;
    const current = found.find(c => c.mesh === this.target) ?? null;
    const challenger = best && best.mesh !== this.target && (!current || best.score < current.score - SWITCH_MARGIN)
      ? best.mesh : null;
    if (challenger) {
      if (this.challenger !== challenger) {
        this.challenger = challenger;
        this.challengerSince = now;
      }
      if (now - this.challengerSince >= (this.target ? SWITCH_DELAY : ACQUIRE_DELAY)) this.setTarget(challenger, now);
    } else {
      this.challenger = null;
    }
    if (!this.target) return;
    if (current) {
      this.lostSince = null;
    } else {
      this.lostSince ??= now;
      if (now - this.lostSince >= GRACE) this.setTarget(null, now);
    }
  }

  update(gaze, enabled = true, now = performance.now()) {
    this.camera.updateMatrixWorld();
    this.gazeCamera.updateMatrixWorld();
    this.blocks.updateWorldMatrix(true, true);
    this.track(gaze, enabled, now);

    const pinched = new Set(this.frame.hands.filter(h => h.pinching).map(h => h.side));
    for (const side of this.grabs.keys()) if (!pinched.has(side) || !enabled) this.grabs.delete(side);
    for (const hand of this.frame.hands) {
      if (!this.pinchPosition(hand.side, this.pinch)) continue;
      if (enabled && hand.pinching && !hand.held && !this.wasPinched.has(hand.side) && this.target &&
          ![...this.grabs.values()].some(grab => grab.mesh === this.target)) {
        const start = this.target.getWorldPosition(new THREE.Vector3());
        const depth = -this.camera.worldToLocal(start.clone()).z;
        const handDepth = -this.camera.worldToLocal(this.pinch.clone()).z;
        this.grabs.set(hand.side, { mesh: this.target, start, pinch: this.pinch.clone(),
          gain: Math.max(1, Math.min(6, depth / Math.max(.1, handDepth))),
          // Only a pinch on a target the gaze was still supporting can teach calibration.
          startedAt: now, learnable: this.lostSince === null && now - this.targetSince >= LEARN_DWELL,
          rect: this.centralRect(this.target), learned: false });
      }
      const grab = this.grabs.get(hand.side);
      if (!grab || hand.held) continue; // freeze exactly during a brief tracking hold
      if (!grab.learned && now - grab.startedAt >= LEARN_HOLD) {
        grab.learned = true;
        if (grab.learnable && grab.rect) this.onLearn?.({ rect: grab.rect, at: grab.startedAt, now, aspect: this.gazeCamera.aspect });
      }
      this.world.copy(this.pinch).sub(grab.pinch).multiplyScalar(grab.gain).add(grab.start);
      // Simple floor constraint, not an object-to-object physics solver.
      this.bounds.setFromObject(grab.mesh).getSize(this.size);
      this.world.y = Math.max(this.size.y / 2, this.world.y);
      grab.mesh.position.copy(grab.mesh.parent.worldToLocal(this.world));
    }
    this.wasPinched = pinched;
    this.highlight();
  }

  // The middle half of a block's screen outline: where a user who is looking at the block is plausibly looking.
  centralRect(mesh) {
    const rect = this.screenRect(mesh);
    if (!rect) return null;
    const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
    const hw = (rect.x1 - rect.x0) / 4, hh = (rect.y1 - rect.y0) / 4;
    return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
  }

  highlight() {
    for (const [mesh, base] of this.baseMaterials) {
      mesh.material.emissive.copy(base.emissive);
      mesh.material.emissiveIntensity = base.intensity;
    }
    if (this.target) {
      this.target.material.emissive.setHex(0xf4c95d);
      this.target.material.emissiveIntensity = .35;
    }
    for (const { mesh } of this.grabs.values()) {
      mesh.material.emissive.setHex(0x5bbfbd);
      mesh.material.emissiveIntensity = .5;
    }
  }
}
