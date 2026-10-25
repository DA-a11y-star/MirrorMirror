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
// Fast carries blur the fingers, so the pinch can read "open" for a frame or two while the hand is still holding the
// block. If the hand moved this fast (tracker m/s, palm) within FAST_MEMORY ms before the pinch opened and is still visible, an open
// pinch must persist OPEN_GRACE ms (0.5 s) before it counts as a release. Slow, deliberate releases stay instant.
const FAST_SPEED = .5;
const FAST_MEMORY = 300;
const OPEN_GRACE = 500;

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
    this.lastEnd = ''; // why the most recent grab ended, shown on the HUD for tuning
    this.wasPinched = new Set();
    this.remote = { held: new Set(), looking: new Set() }; // block ids other users are holding / looking at
    this.resetTargeting();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pinch = new THREE.Vector3();
    this.world = new THREE.Vector3();
    this.bounds = new THREE.Box3();
    this.corner = new THREE.Vector3();
    this.baseMaterials = new Map();
    for (const root of blocks.children) this.register(root);
  }

  register(root) {
    root.traverse(mesh => {
      if (mesh.isMesh) this.baseMaterials.set(mesh, {
        emissive: mesh.material.emissive.clone(), intensity: mesh.material.emissiveIntensity,
      });
    });
  }

  unregister(root) {
    if (this.target === root || this.challenger === root) this.resetTargeting();
    for (const [side, grab] of this.grabs) if (grab.mesh === root) this.grabs.delete(side);
    root.traverse(mesh => this.baseMaterials.delete(mesh));
  }

  rootOf(object) {
    while (object && object.parent !== this.blocks) object = object.parent;
    return object ?? null;
  }

  setFrame(frame) {
    this.frame = frame;
  }

  // Blocks another user is holding belong to them: they can't be targeted or grabbed until released.
  setRemote(held, looking) {
    this.remote = { held, looking };
  }

  // Another user took a block this laptop was holding. The pinch stays consumed until released and repeated.
  drop(id) {
    for (const [side, grab] of this.grabs) if (grab.mesh.userData.id === id) this.grabs.delete(side);
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
    const hit = this.rootOf(this.raycaster.intersectObjects(this.blocks.children, true)[0]?.object);
    const found = [];
    for (const mesh of this.blocks.children) {
      if (this.remote.held.has(mesh.userData.id)) continue;
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
    if (this.target && this.remote.held.has(this.target.userData.id)) this.setTarget(null, now);
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
    for (const [side, grab] of this.grabs) {
      const slot = this.hands.slots.find(slot => slot.side === side);
      const speed = slot?.velocity?.[9]?.length() ?? 0;
      if (enabled && pinched.has(side)) {
        if (grab.openSince !== null) grab.reanchor = true; // the pinch came back inside the grace
        grab.openSince = null;
        if (speed >= FAST_SPEED) grab.fastAt = now;
        continue;
      }
      grab.openSince ??= now;
      const visible = this.frame.hands.some(h => h.side === side && !h.held);
      // "Was it moving fast?" is judged when the pinch opened, not now, so the grace is a full OPEN_GRACE long.
      if (enabled && visible && grab.openSince - grab.fastAt < FAST_MEMORY && now - grab.openSince < OPEN_GRACE) continue;
      this.lastEnd = `grab ended: ${!enabled ? 'mode change' : visible ? 'pinch opened' : 'hand lost'} at ${speed.toFixed(2)} m/s`;
      this.grabs.delete(side);
    }
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
          startedAt: now, fastAt: -Infinity, openSince: null, learnable: this.lostSince === null && now - this.targetSince >= LEARN_DWELL,
          rect: this.centralRect(this.target), learned: false });
      }
      const grab = this.grabs.get(hand.side);
      if (!grab || hand.held) continue; // freeze exactly during a brief tracking hold
      // The grace keeps the grab alive across a flicker; it must not keep following an open hand.
      if (grab.openSince !== null) continue;
      if (grab.reanchor) { // pinch returned: rebuild the offset from where the block now is, so it doesn't jump
        grab.mesh.getWorldPosition(grab.start);
        grab.pinch.copy(this.pinch);
        grab.reanchor = false;
        continue;
      }
      if (!grab.learned && now - grab.startedAt >= LEARN_HOLD) {
        grab.learned = true;
        if (grab.learnable && grab.rect) this.onLearn?.({ rect: grab.rect, at: grab.startedAt, now, aspect: this.gazeCamera.aspect });
      }
      this.world.copy(this.pinch).sub(grab.pinch).multiplyScalar(grab.gain).add(grab.start);
      // Simple floor constraint, not an object-to-object physics solver.
      this.bounds.setFromObject(grab.mesh);
      const currentY = grab.mesh.getWorldPosition(this.corner).y;
      this.world.y = Math.max(currentY - this.bounds.min.y, this.world.y);
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
    // Other users: violet while they look at a block, brighter while they hold it. Local highlights win.
    for (const mesh of this.blocks.children) {
      const id = mesh.userData.id;
      if (!this.remote.held.has(id) && !this.remote.looking.has(id)) continue;
      this.tint(mesh, 0x8f7cf0, this.remote.held.has(id) ? .45 : .22);
    }
    if (this.target) {
      this.tint(this.target, 0xf4c95d, .35);
    }
    for (const { mesh } of this.grabs.values()) {
      this.tint(mesh, 0x5bbfbd, .5);
    }
  }

  tint(root, color, intensity) {
    root.traverse(mesh => {
      if (!mesh.isMesh) return;
      mesh.material.emissive.setHex(color);
      mesh.material.emissiveIntensity = intensity;
    });
  }
}
