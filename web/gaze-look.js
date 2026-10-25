// Look where you look: when the eyes rest toward the edge of the screen the view turns that way, as if the head turned,
// and keeps turning until the gaze comes back toward the middle. A pure rate controller: it only produces how much to
// turn this frame (the same dYaw / dPitch the mouse produces), so locomotion and the cameras need no changes.
//
// The middle of the screen is a dead zone, so ordinary targeting (looking at a block you want) never moves the view.
// Gaze has to rest outside it for DWELL_MS before the turn starts, so a glance at a corner does nothing, and the turn
// then eases in over RAMP_MS so it never lurches.

// The live tunables: mutate from the console or the Settings dropdown and the next frame picks it up.
export const GAZE_LOOK = {
  ENABLED: true,
  DEAD_X: 0.55,        // fraction of the half-width that is dead (0.55: the middle 55% of the screen's width)
  DEAD_Y: 0.5,         // the same, for the height
  MAX_YAW_DEG_S: 80,   // turn rate with the gaze at the very edge
  MAX_PITCH_DEG_S: 50,
  SPEED: 1,            // multiplies both rates (the Settings slider)
  EXPO: 1.5,           // gentle just past the dead zone, full rate at the edge
  DWELL_MS: 250,       // gaze must rest outside the dead zone this long before the view starts to turn
  RAMP_MS: 250,        // then the turn eases in over this long
  MIN_CONF: 0.5,
};

const DEG = Math.PI / 180;

// 0 inside the dead zone, rising to 1 at the screen edge. `e` is the gaze's offset from the centre, -1..1.
export function excess(e, dead) {
  const a = Math.abs(e);
  return a <= dead ? 0 : Math.min(1, (a - dead) / (1 - dead));
}

export class GazeLook {
  constructor(cfg = GAZE_LOOK) {
    this.cfg = cfg;
    this.dwell = 0; // ms the gaze has rested outside the dead zone
  }

  // `gaze` is {x, y, conf} on the screen (0..1, y down) or null. `enabled` is the app's say (not while a block is held or
  // calibrating). Returns { dYaw, dPitch } in radians for this frame: dYaw > 0 turns left, dPitch > 0 looks up.
  update(gaze, dtSeconds, enabled = true) {
    const c = this.cfg;
    const still = { dYaw: 0, dPitch: 0 };
    if (!c.ENABLED || !enabled || !gaze || !(gaze.conf >= c.MIN_CONF) || !Number.isFinite(gaze.x) || !Number.isFinite(gaze.y)) {
      this.dwell = 0;
      return still;
    }
    const ex = (gaze.x - 0.5) * 2;
    const ey = (0.5 - gaze.y) * 2;
    const ax = excess(ex, c.DEAD_X);
    const ay = excess(ey, c.DEAD_Y);
    if (ax === 0 && ay === 0) {
      this.dwell = 0;
      return still;
    }
    this.dwell += dtSeconds * 1000;
    const ramp = Math.max(0, Math.min(1, (this.dwell - c.DWELL_MS) / c.RAMP_MS));
    if (ramp === 0) return still;
    const dt = Math.min(dtSeconds, 0.05);
    return {
      dYaw: -Math.sign(ex) * ax ** c.EXPO * c.MAX_YAW_DEG_S * c.SPEED * DEG * ramp * dt, // gaze right turns the view right
      dPitch: Math.sign(ey) * ay ** c.EXPO * c.MAX_PITCH_DEG_S * c.SPEED * DEG * ramp * dt,
    };
  }
}
