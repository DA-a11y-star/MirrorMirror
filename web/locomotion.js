import * as THREE from 'three';

// Intents -> avatar pose. Pure simulation: no DOM, no keyboard, no rendering.
export const FLY_SPEED = 4; // m/s
export const TURN_RATE = THREE.MathUtils.degToRad(120); // rad/s at full turn input
export const ACCEL_K = 10; // 1/s, used by every smoothed velocity: vel = lerp(vel, target, 1 - exp(-k dt))
export const PITCH_LIMIT = THREE.MathUtils.degToRad(85);
export const WORLD_BOUND = 20; // m, half size of the square the avatar stays in
export const FLY_CEILING = 12; // m
export const MAX_DT = 0.05;

const IDLE = {
  move: { forward: 0, strafe: 0, vertical: 0 },
  turn: 0,
  look: { dYaw: 0, dPitch: 0 },
  zoom: 0,
  toggles: {},
};

// Smoothing factor for a rate in 1/s; identical results at any frame rate.
export const smoothing = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Locomotion {
  // `spawn` is where (re)spawning puts the avatar: { pos: [x, y, z], yaw, pitch }. Defaults to the origin.
  // `bound` is the half size of the square the avatar stays in and `ceiling` its highest altitude (a big set raises both).
  constructor({ spawn = {}, bound = WORLD_BOUND, ceiling = FLY_CEILING } = {}) {
    this.bound = bound;
    this.ceiling = ceiling;
    this.spawn = { pos: [0, 0, 0], yaw: 0, pitch: 0, ...spawn };
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; // radians, 0 faces -z, positive turns left
    this.pitch = 0; // radians, positive looks up, clamped to +-85 degrees
    this.turnVel = 0;
    this.pitchVel = 0;
    this.grounded = true; // standing on the floor (not flying clear of it)
    this.floorAt = null; // (x, z) => floor height; null is a flat floor at 0
    this.flying = true; // always on: vertical is live, y is only clamped to the floor
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this.respawn();
  }

  respawn() {
    this.pos.set(...this.spawn.pos);
    this.vel.set(0, 0, 0);
    this.yaw = this.spawn.yaw;
    this.pitch = this.spawn.pitch;
    this.turnVel = 0;
    this.pitchVel = 0;
    this.grounded = true;
    this.flying = true;
  }

  // `enabled` is false while free cam owns the input: the avatar then stays where it is and just coasts to a stop.
  update(intents, dt, enabled = true) {
    dt = Math.min(Math.max(dt, 0), MAX_DT);
    const i = enabled ? intents : IDLE;
    const toggles = i.toggles ?? {};
    if (toggles.reset) this.respawn();
    this.flying = true;

    this.yaw += i.look.dYaw;
    this.turnVel += (i.turn * TURN_RATE - this.turnVel) * smoothing(ACCEL_K, dt);
    this.yaw += this.turnVel * dt;
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw)); // keep in (-pi, pi]
    this.pitchVel += ((i.pitch ?? 0) * TURN_RATE - this.pitchVel) * smoothing(ACCEL_K, dt);
    this.pitch = THREE.MathUtils.clamp(this.pitch + i.look.dPitch + this.pitchVel * dt, -PITCH_LIMIT, PITCH_LIMIT);

    const speed = FLY_SPEED;
    this._f.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._r.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const t = this._target.set(0, 0, 0)
      .addScaledVector(this._f, i.move.forward)
      .addScaledVector(this._r, i.move.strafe);
    if (t.length() > 1) t.normalize(); // diagonals are not faster
    t.multiplyScalar(speed);
    t.y = THREE.MathUtils.clamp(i.move.vertical, -1, 1) * speed;
    this.vel.lerp(t, smoothing(ACCEL_K, dt));

    const wasY = this.pos.y;
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -this.bound, this.bound);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -this.bound, this.bound);
    // Never below the floor under you. `floorAt(x, z)` (set by the world) knows about decks and raised paths. Stepping
    // onto a higher floor lifts you smoothly; pressing down into a floor you are already on just stops at it.
    this.pos.y = Math.max(this.pos.y, 0);
    const floor = this.floorAt ? this.floorAt(this.pos.x, this.pos.z) : 0;
    if (this.pos.y < floor) {
      const steppedUp = wasY < floor - 0.002;
      this.pos.y = steppedUp && floor - this.pos.y >= 0.002 ? this.pos.y + (floor - this.pos.y) * smoothing(25, dt) : floor;
    }
    // Walking off the edge of a deck settles back down to the ground, like walking; lifting off (vertical input) is flying.
    if (this.grounded && floor < this.pos.y - 0.002 && i.move.vertical <= 0.05) {
      this.pos.y = this.pos.y - floor < 0.004 ? floor : this.pos.y + (floor - this.pos.y) * smoothing(12, dt);
    }
    this.grounded = this.pos.y <= floor + 0.01;
    this.pos.y = Math.min(this.pos.y, this.ceiling);
    return this;
  }

  // Snapshot for the relay's `state` message (position, yaw, head pitch, fly state) and for local rendering.
  state() {
    return {
      pos: this.pos.toArray(),
      vel: this.vel.toArray(),
      yaw: this.yaw,
      pitch: this.pitch,
      flying: this.flying,
    };
  }
}
