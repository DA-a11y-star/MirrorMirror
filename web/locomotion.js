import * as THREE from 'three';

// Intents -> avatar pose. Pure simulation: no DOM, no keyboard, no rendering.
export const WALK_SPEED = 2; // m/s
export const FLY_SPEED = 4; // m/s
export const TURN_RATE = THREE.MathUtils.degToRad(120); // rad/s at full turn input
export const ACCEL_K = 10; // 1/s, used by every smoothed velocity: vel = lerp(vel, target, 1 - exp(-k dt))
export const PITCH_LIMIT = THREE.MathUtils.degToRad(85);
export const WORLD_BOUND = 20; // m, half size of the square the avatar stays in
export const FLY_CEILING = 12; // m
const LAND_RATE = 6; // 1/s, ease down to the floor after leaving fly mode
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
  constructor({ spawn = {} } = {}) {
    this.spawn = { pos: [0, 0, 0], yaw: 0, pitch: 0, ...spawn };
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; // radians, 0 faces -z, positive turns left
    this.pitch = 0; // radians, positive looks up, clamped to +-85 degrees
    this.turnVel = 0;
    this.flying = false;
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
    this.flying = false;
  }

  // `enabled` is false while free cam owns the input: the avatar then stays where it is and just coasts to a stop.
  update(intents, dt, enabled = true) {
    dt = Math.min(Math.max(dt, 0), MAX_DT);
    const i = enabled ? intents : IDLE;
    const toggles = i.toggles ?? {};
    if (toggles.reset) this.respawn();
    if (toggles.fly) this.flying = !this.flying;

    this.yaw += i.look.dYaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + i.look.dPitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.turnVel += (i.turn * TURN_RATE - this.turnVel) * smoothing(ACCEL_K, dt);
    this.yaw += this.turnVel * dt;
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw)); // keep in (-pi, pi]

    const speed = this.flying ? FLY_SPEED : WALK_SPEED;
    this._f.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._r.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const t = this._target.set(0, 0, 0)
      .addScaledVector(this._f, i.move.forward)
      .addScaledVector(this._r, i.move.strafe);
    if (t.length() > 1) t.normalize(); // diagonals are not faster
    t.multiplyScalar(speed);
    t.y = this.flying ? THREE.MathUtils.clamp(i.move.vertical, -1, 1) * speed : 0;
    this.vel.lerp(t, smoothing(ACCEL_K, dt));

    this.pos.addScaledVector(this.vel, dt);
    if (!this.flying) {
      this.pos.y -= this.pos.y * smoothing(LAND_RATE, dt); // short ease to the floor
      if (this.pos.y < 0.002) this.pos.y = 0;
    }
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -WORLD_BOUND, WORLD_BOUND);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -WORLD_BOUND, WORLD_BOUND);
    this.pos.y = THREE.MathUtils.clamp(this.pos.y, 0, FLY_CEILING);
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
