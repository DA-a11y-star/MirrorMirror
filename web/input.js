// The only file that reads the keyboard, mouse or wheel. Everything else consumes the intents object that
// poll() returns once per frame, so hand gestures can later produce the same object and replace the keyboard.
//
//   move:    { forward, strafe, vertical }  each -1..1 (forward +1 = ahead, strafe +1 = right, vertical +1 = up)
//   turn:    -1..1, +1 = turn left (counter-clockwise, yaw increases)
//   look:    { dYaw, dPitch } radians this frame; dYaw > 0 = left, dPitch > 0 = up
//   zoom:    scroll notches this frame; > 0 = scroll down (zoom out / slower)
//   toggles: edge-triggered, true for exactly one frame
//            { mode, voice, view, freeCam, dev, depthFx, reset, recenter }

export const MOUSE_SENSITIVITY = 0.0022; // radians per pixel of pointer-lock movement

const KEY_TOGGLES = {
  KeyM: 'mode',
  KeyT: 'voice', // dev fallback for the single-fist voice trigger
  KeyV: 'view',
  KeyC: 'freeCam',
  Backquote: 'dev',
  KeyP: 'depthFx',
  KeyR: 'reset',
  KeyH: 'recenter',
};
const HELD_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight',
]);
const PREVENT_DEFAULT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

export function emptyIntents() {
  return {
    move: { forward: 0, strafe: 0, vertical: 0 },
    turn: 0,
    pitch: 0,                     // -1..1 look-pitch rate (left-hand stick)
    look: { dYaw: 0, dPitch: 0 },
    zoom: 0,
    toggles: { mode: false, voice: false, view: false, freeCam: false, dev: false, depthFx: false, reset: false, recenter: false },
  };
}

// Voice controls own their keys too: Space/Enter record rather than moving the avatar or blurring the mic button.
function isTyping(target) {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || !!target.closest?.('#voice-tools'));
}

export class Input {
  // `element` is the canvas: clicking it requests pointer lock for mouse look. With `mouseFallback` the left button
  // is a pinch (see mouse-tracker.js), so only a right-click locks the pointer.
  constructor(element, { target = window, mouseFallback = false } = {}) {
    this.element = element;
    this.held = new Set();
    this.pressed = new Set();
    this.tapped = new Set(); // held keys pressed since the last poll, so a tap shorter than one frame still counts
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.locked = false;

    target.addEventListener('keydown', e => this._keyDown(e));
    target.addEventListener('keyup', e => this._keyUp(e));
    target.addEventListener('blur', () => this.clear());
    target.addEventListener('wheel', e => {
      if (e.target instanceof Element && e.target.closest('#tools, #calibration, #voice-tools')) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 1 : 100; // lines vs pixels
      this.wheel += e.deltaY / unit;
    }, { passive: false });

    element.addEventListener(mouseFallback ? 'contextmenu' : 'click', e => {
      if (mouseFallback) e.preventDefault();
      if (!this.locked) element.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
  }

  clear() {
    this.held.clear();
    this.pressed.clear();
    this.tapped.clear();
  }

  _keyDown(e) {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const isGame = HELD_KEYS.has(e.code) || e.code in KEY_TOGGLES;
    if (!isGame) return;
    if (PREVENT_DEFAULT.has(e.code)) e.preventDefault(); // no page scroll, no focused-button activation
    if (e.target instanceof HTMLButtonElement) e.target.blur();
    if (HELD_KEYS.has(e.code)) {
      this.held.add(e.code);
      this.tapped.add(e.code);
    }
    if (e.code in KEY_TOGGLES && !e.repeat) this.pressed.add(KEY_TOGGLES[e.code]);
  }

  _keyUp(e) {
    if (e.code === 'Space' && !isTyping(e.target)) e.preventDefault(); // a focused button would click on Space keyup
    this.held.delete(e.code);
  }

  // Once per frame. Consumes accumulated mouse/wheel deltas and the edge-triggered toggles.
  poll() {
    const down = code => (this.held.has(code) || this.tapped.has(code) ? 1 : 0);
    const intents = emptyIntents();
    intents.move.forward = down('ArrowUp') - down('ArrowDown');
    intents.move.strafe = down('KeyD') - down('KeyA');
    intents.move.vertical = down('Space') - Math.max(down('ShiftLeft'), down('ShiftRight'));
    intents.turn = down('ArrowLeft') - down('ArrowRight');
    intents.look.dYaw = (0 - this.dx) * MOUSE_SENSITIVITY; // 0 - x, not -x, so no negative zero
    intents.look.dPitch = (0 - this.dy) * MOUSE_SENSITIVITY;
    intents.zoom = this.wheel;
    for (const name of this.pressed) intents.toggles[name] = true;
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.pressed.clear();
    this.tapped.clear();
    return intents;
  }
}
