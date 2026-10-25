// Camera-free fallback: the mouse stands in for the tracker so the demo survives a dead camera (?tracker=mouse).
// The cursor is both gaze and a right hand's pinch point; holding the left button pinches. It emits the same
// messages as the Python tracker (protocol in CLAUDE.md), so nothing downstream knows the difference.
import * as THREE from 'three';
import { screenToTracker } from './hands.js';
import { poseHand } from './mock.js';

const RATE_HZ = 30;

// What the mouse is doing, kept apart from the DOM so it can be tested. Positions are 0..1 from the top left.
export class MousePointer {
  constructor() {
    this.x = 0.5;
    this.y = 0.5;
    this.inside = false;
    this.down = false;
  }

  move(x, y) {
    this.x = x;
    this.y = y;
    this.inside = true;
  }

  // Only a press on the scene itself pinches; clicks on the panels around it must not grab what you look at.
  press(onScene) {
    if (onScene) this.down = true;
  }

  release() {
    this.down = false;
  }

  // The pointer left the page, or the window lost focus: let go so no grab is left hanging.
  leave() {
    this.down = false;
    this.inside = false;
  }
}

// The frame for one tick. `view` is { fov, aspect } of the camera the hand is drawn through. The pinch point (thumb and
// index midpoint) sits exactly under the cursor whether or not the button is down, so a click never nudges a grab.
export function mouseFrame(pointer, view, t) {
  const pinch = pointer.down ? 1 : 0;
  const pts = poseHand(-1, pinch);
  const mid = pts[4].clone().add(pts[8]).multiplyScalar(0.5);
  const at = new THREE.Vector3(...screenToTracker(pointer.x, pointer.y, view));
  const lm = pts.map(p => p.sub(mid).add(at).toArray().map(v => +v.toFixed(4)));
  const hands = pointer.inside ? [{ side: 'right', lm, pinch, pinching: pointer.down, held: false, t }] : [];
  return { type: 'frame', t, hands, gaze: null, head: null }; // gaze comes from GazeInput's own pointer source
}

export function startMouseTracker(onMessage, camera, element) {
  const pointer = new MousePointer();
  const at = e => [e.clientX / window.innerWidth, e.clientY / window.innerHeight];
  const onMove = e => pointer.move(...at(e));
  const onDown = e => {
    if (e.button !== 0) return;
    pointer.move(...at(e));
    pointer.press(e.target === element);
  };
  const onUp = e => { if (e.button === 0) pointer.release(); };
  const onLeave = () => pointer.leave();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onLeave);
  window.addEventListener('blur', onLeave);
  document.documentElement.addEventListener('pointerleave', onLeave);

  const t0 = performance.now();
  let pinching = false;
  const timer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    const frame = mouseFrame(pointer, camera, t);
    const now = frame.hands[0]?.pinching ?? false;
    onMessage(frame);
    if (now !== pinching) onMessage({ type: 'gesture', name: now ? 'pinch_start' : 'pinch_end', hand: 'right' });
    pinching = now;
  }, 1000 / RATE_HZ);
  return () => {
    clearInterval(timer);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onLeave);
    window.removeEventListener('blur', onLeave);
    document.documentElement.removeEventListener('pointerleave', onLeave);
  };
}
