// Temporal machines on top of the tracker's one-frame poses. Writes the same intents as input.js.
// Keyboard remains a fallback: main.js adds the two together and clamps.
// Defaults match web/config.js `GESTURE`; pass that object so sliders mutate live.

export const DEFAULTS = {
  DOMINANT: 'right',
  DEAD_LATERAL: 0.28,
  DEAD_VERTICAL: 0.28,
  DEAD_DEPTH: 0.08,
  FULL_LATERAL: 2.29,
  FULL_VERTICAL: 2.57,
  FULL_DEPTH: 0.57,
  DEAD_LOOK_LATERAL: 0.28,
  DEAD_LOOK_VERTICAL: 0.28,
  FULL_LOOK_LATERAL: 1.8,
  FULL_LOOK_VERTICAL: 2.2,
  EXPO: 1.8,
  ENGAGE_MS: 150,
  DISENGAGE_MS: 150,
  LOW_CONF_MS: 100,
  TOGGLE_FIST_MS: 120,
  TOGGLE_ONSET_MS: 700,
  TOGGLE_OPEN_WINDOW_MS: 1400,
  TOGGLE_COOLDOWN_MS: 800,
  AXIS_ISOLATION: 2,
  AXIS_ISOLATION_SCALE: 0.5,
};

const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

export function curve(v, dead, full, expo) {
  const mag = Math.abs(v);
  if (!(full > dead) || mag < dead) return 0;
  const a = Math.min(1, (mag - dead) / (full - dead));
  return Math.sign(v) * a ** expo;
}

export function isolateAxes(axes, ratio = DEFAULTS.AXIS_ISOLATION, scale = DEFAULTS.AXIS_ISOLATION_SCALE) {
  const keys = Object.keys(axes);
  const abs = Object.fromEntries(keys.map(k => [k, Math.abs(axes[k])]));
  const winner = keys.reduce((a, b) => (abs[a] >= abs[b] ? a : b));
  if (keys.every(k => k === winner || abs[winner] > ratio * abs[k])) {
    const out = { ...axes };
    for (const k of keys) if (k !== winner) out[k] *= scale;
    return out;
  }
  return axes;
}

function handBySide(hands, side) {
  return hands.find(h => h.side === side) ?? null;
}

function isFist(hand) {
  return !!hand && hand.pose === 'fist';
}

function isClosed(hand) {
  // A pinch or fist drops the joystick, but only a fist counts for the mode toggle.
  return !!hand && (hand.pose === 'fist' || hand.pose === 'pinch');
}

function isOpen(hand) {
  return !!hand && hand.pose === 'open';
}

function emptyStick() {
  return {
    engaged: false, center: null, samples: [], openSince: null, lowConfSince: null, decaying: null,
    raw: { lateral: 0, vertical: 0, depth: 0 },
    curved: { lateral: 0, vertical: 0, depth: 0 },
  };
}

function emptyOut() {
  return { forward: 0, strafe: 0, vertical: 0, turn: 0, pitch: 0 };
}

export class Gestures {
  constructor(cfg = DEFAULTS) {
    this.cfg = cfg;
    this.mode = 'MOVE';
    this.toggle = { state: 'IDLE', armedAt: 0, onset: { left: null, right: null }, since: { left: null, right: null } };
    this.move = emptyStick(); // right hand: forward / up-down
    this.look = emptyStick(); // left hand: yaw
    this.joy = { engaged: false, side: 'right', center: null, raw: emptyStick().raw, curved: emptyStick().curved, out: emptyOut() };
    this.fired = false;
  }

  toggleMode() {
    this.mode = this.mode === 'MOVE' ? 'EDIT' : 'MOVE';
    this._disengageBoth();
    this.fired = true;
    return this.mode;
  }

  setFrame(hands, now) {
    this.hands = Array.isArray(hands) ? hands : [];
    this.now = now;
    this._stepToggle(now);
    this._stepSticks(now);
  }

  apply(intents) {
    const g = this.joy.out;
    intents.move.forward = clamp(intents.move.forward + g.forward);
    intents.move.strafe = clamp(intents.move.strafe + g.strafe);
    intents.move.vertical = clamp(intents.move.vertical + g.vertical);
    intents.turn = clamp(intents.turn + g.turn);
    intents.pitch = clamp((intents.pitch ?? 0) + g.pitch);
    if (this.fired) {
      intents.toggles.mode = true;
      this.fired = false;
    }
    return intents;
  }

  debug() {
    const by = side => {
      const h = handBySide(this.hands ?? [], side);
      if (!h) return `${side}: -`;
      const p = h.palm ?? {};
      return `${side}: ${h.pose ?? '?'} ${((h.pose_conf ?? 0) * 100).toFixed(0)}%  palm ${p.x?.toFixed?.(2) ?? '-'},${p.y?.toFixed?.(2) ?? '-'} s=${p.scale?.toFixed?.(3) ?? '-'}`;
    };
    const fmt = c => (c ? `${c.x.toFixed(2)},${c.y.toFixed(2)} s=${c.scale.toFixed(3)}` : '-');
    return {
      mode: this.mode,
      toggle: this.toggle.state,
      engaged: this.joy.engaged,
      side: this.joy.side,
      hands: `${by('left')}  |  ${by('right')}`,
      center: `move ${fmt(this.move.center)}  look ${fmt(this.look.center)}`,
      raw: this.joy.raw,
      curved: this.joy.curved,
      out: this.joy.out,
    };
  }

  _stepToggle(now) {
    const cfg = this.cfg;
    const left = handBySide(this.hands, 'left');
    const right = handBySide(this.hands, 'right');
    const bothVisible = !!(left && right);

    if (this.toggle.state === 'COOLDOWN') {
      if (now - this.toggle.armedAt < cfg.TOGGLE_COOLDOWN_MS) return;
      this.toggle.state = 'IDLE';
    }

    if (!bothVisible) {
      this.toggle.onset.left = this.toggle.onset.right = null;
      this.toggle.since.left = this.toggle.since.right = null;
      if (this.toggle.state === 'ARMED') this._idleToggle();
      return;
    }

    for (const [side, hand] of [['left', left], ['right', right]]) {
      if (isFist(hand)) {
        if (this.toggle.since[side] == null) {
          this.toggle.since[side] = now;
          this.toggle.onset[side] = now;
        }
      } else {
        this.toggle.since[side] = null;
      }
    }

    if (this.toggle.state === 'IDLE') {
      const held = this.toggle.since.left != null && this.toggle.since.right != null
        && now - this.toggle.since.left >= cfg.TOGGLE_FIST_MS
        && now - this.toggle.since.right >= cfg.TOGGLE_FIST_MS;
      const together = this.toggle.onset.left != null && this.toggle.onset.right != null
        && Math.abs(this.toggle.onset.left - this.toggle.onset.right) <= cfg.TOGGLE_ONSET_MS;
      if (held && together) {
        this.toggle.state = 'ARMED';
        this.toggle.armedAt = now;
        this._disengageBoth(now);
      }
      return;
    }

    if (this.toggle.state === 'ARMED') {
      if (now - this.toggle.armedAt > cfg.TOGGLE_OPEN_WINDOW_MS) {
        this._idleToggle();
        return;
      }
      if (isOpen(left) && isOpen(right)) {
        this.toggleMode();
        this.toggle.state = 'COOLDOWN';
        this.toggle.armedAt = now;
      }
    }
  }

  _idleToggle() {
    this.toggle.state = 'IDLE';
    this.toggle.onset.left = this.toggle.onset.right = null;
    this.toggle.since.left = this.toggle.since.right = null;
  }

  _stepSticks(now) {
    const out = emptyOut();
    if (this.mode !== 'MOVE' || this.toggle.state === 'ARMED') {
      this._disengageBoth(now);
    } else {
      this._stepStick(this.move, handBySide(this.hands, 'right'), now, 'move', out);
      this._stepStick(this.look, handBySide(this.hands, 'left'), now, 'look', out);
    }
    this._decayStick(this.move, now);
    this._decayStick(this.look, now);
    if (this.move.decaying) {
      const k = this._decayK(this.move, now);
      if (k > 0) {
        out.forward += this.move.decaying.from.forward * k;
        out.strafe += this.move.decaying.from.strafe * k;
        out.vertical += this.move.decaying.from.vertical * k;
      }
    }
    if (this.look.decaying) {
      const k = this._decayK(this.look, now);
      if (k > 0) {
        out.turn += this.look.decaying.from.turn * k;
        out.pitch += this.look.decaying.from.pitch * k;
      }
    }
    this.joy.out = {
      forward: clamp(out.forward), strafe: clamp(out.strafe), vertical: clamp(out.vertical),
      turn: clamp(out.turn), pitch: clamp(out.pitch),
    };
    this.joy.engaged = this.move.engaged || this.look.engaged;
    this.joy.side = this.move.engaged ? 'right' : this.look.engaged ? 'left' : 'right';
    this.joy.center = this.move.center ?? this.look.center;
    this.joy.raw = {
      lateral: this.look.raw.lateral,
      vertical: this.move.raw.vertical,
      depth: this.move.raw.depth,
    };
    this.joy.curved = {
      lateral: this.look.curved.lateral,
      vertical: this.move.curved.vertical,
      depth: this.move.curved.depth,
    };
  }

  _stepStick(stick, hand, now, role, out) {
    if (isClosed(hand)) {
      this._clutch(stick); // one fist recenters that stick; the other hand is untouched
      return;
    }
    if (!hand || ((hand.pose_conf ?? 0) < 0.5 && stick.engaged && !isOpen(hand))) {
      if (stick.engaged && hand && (hand.pose_conf ?? 0) < 0.5 && stick.lowConfSince != null
          && now - stick.lowConfSince < this.cfg.LOW_CONF_MS) {
        this._driveStick(stick, hand, role, out);
        return;
      }
      if (stick.engaged && hand && (hand.pose_conf ?? 0) < 0.5 && stick.lowConfSince == null) {
        stick.lowConfSince = now;
        this._driveStick(stick, hand, role, out);
        return;
      }
      this._disengage(stick, now, role);
      return;
    }
    stick.lowConfSince = null;
    if (!isOpen(hand) || (hand.pose_conf ?? 0) <= 0.55) {
      if (!stick.engaged) {
        stick.openSince = null;
        stick.samples = [];
      } else if (hand.pose === 'other') {
        this._driveStick(stick, hand, role, out);
      } else {
        this._disengage(stick, now, role);
      }
      return;
    }

    if (!stick.engaged) {
      if (stick.openSince == null) stick.openSince = now;
      if (hand.palm) stick.samples.push({ ...hand.palm });
      if (now - stick.openSince >= this.cfg.ENGAGE_MS && stick.samples.length) {
        const n = stick.samples.length;
        stick.center = {
          x: stick.samples.reduce((s, p) => s + p.x, 0) / n,
          y: stick.samples.reduce((s, p) => s + p.y, 0) / n,
          scale: stick.samples.reduce((s, p) => s + p.scale, 0) / n,
        };
        stick.engaged = true;
        stick.samples = [];
        stick.decaying = null;
      }
      return;
    }
    this._driveStick(stick, hand, role, out);
  }

  _driveStick(stick, hand, role, out) {
    const c = stick.center;
    const palm = hand.palm;
    if (!c || !palm || !(c.scale > 0) || !(palm.scale > 0)) return;
    const raw = {
      lateral: (palm.x - c.x) / c.scale,
      vertical: -(palm.y - c.y) / c.scale,
      depth: Math.log(Math.max(palm.scale, 1e-6) / c.scale),
    };
    const cfg = this.cfg;
    const look = role === 'look'; // the look hand needs less travel than the move hand
    const curved = isolateAxes({
      lateral: look ? curve(raw.lateral, cfg.DEAD_LOOK_LATERAL, cfg.FULL_LOOK_LATERAL, cfg.EXPO)
        : curve(raw.lateral, cfg.DEAD_LATERAL, cfg.FULL_LATERAL, cfg.EXPO),
      vertical: look ? curve(raw.vertical, cfg.DEAD_LOOK_VERTICAL, cfg.FULL_LOOK_VERTICAL, cfg.EXPO)
        : curve(raw.vertical, cfg.DEAD_VERTICAL, cfg.FULL_VERTICAL, cfg.EXPO),
      depth: curve(raw.depth, cfg.DEAD_DEPTH, cfg.FULL_DEPTH, cfg.EXPO),
    }, cfg.AXIS_ISOLATION, cfg.AXIS_ISOLATION_SCALE);
    stick.raw = raw;
    stick.curved = curved;
    if (role === 'move') {
      // Right hand is a full 3D stick: depth = forward/back, lateral = strafe, raise/lower = fly up/down.
      out.forward += curved.depth;
      out.strafe += curved.lateral;
      out.vertical += curved.vertical;
      stick.lastOut = { forward: curved.depth, strafe: curved.lateral, vertical: curved.vertical, turn: 0, pitch: 0 };
    } else {
      // Left hand: look yaw and pitch.
      // Yaw is inverted: hand right turns the view right (locomotion's +turn is left).
      out.turn -= curved.lateral;
      out.pitch += curved.vertical;
      stick.lastOut = { forward: 0, strafe: 0, vertical: 0, turn: -curved.lateral, pitch: curved.vertical };
    }
  }

  _clutch(stick) {
    stick.engaged = false;
    stick.center = null;
    stick.samples = [];
    stick.openSince = null;
    stick.lowConfSince = null;
    stick.decaying = null;
    stick.lastOut = emptyOut();
    stick.raw = { lateral: 0, vertical: 0, depth: 0 };
    stick.curved = { lateral: 0, vertical: 0, depth: 0 };
  }

  _disengage(stick, now, role) {
    if (stick.engaged && now != null) {
      stick.decaying = { from: stick.lastOut ?? emptyOut(), at: now, role };
    }
    stick.engaged = false;
    stick.center = null;
    stick.samples = [];
    stick.openSince = null;
    stick.lowConfSince = null;
    stick.raw = { lateral: 0, vertical: 0, depth: 0 };
    stick.curved = { lateral: 0, vertical: 0, depth: 0 };
  }

  _disengageBoth(now) {
    this._disengage(this.move, now, 'move');
    this._disengage(this.look, now, 'look');
    this.joy.engaged = false;
    this.joy.center = null;
    this.joy.out = emptyOut();
    this.joy.raw = { lateral: 0, vertical: 0, depth: 0 };
    this.joy.curved = { lateral: 0, vertical: 0, depth: 0 };
  }

  _decayK(stick, now) {
    if (!stick.decaying) return 0;
    const u = (now - stick.decaying.at) / this.cfg.DISENGAGE_MS;
    if (u >= 1) {
      stick.decaying = null;
      return 0;
    }
    return 1 - u;
  }

  _decayStick(stick, now) {
    if (stick.decaying && this._decayK(stick, now) === 0) stick.decaying = null;
  }
}
