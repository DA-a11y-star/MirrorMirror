import * as THREE from 'three';

// Avatar pose + mode -> the base camera pose. The off-axis depth effect (offaxis.js) composes on top of this base
// camera, so nothing here knows about head tracking.
const EYE_HEIGHT = 1.4;
const HEAD_HEIGHT = 1.3; // third-person orbit centre, above the avatar's feet
const TP_MIN = 1.5;
const TP_MAX = 8;
const TP_DEFAULT = 4;
const TP_ZOOM_STEP = 0.5; // meters per scroll notch
const TP_ZOOM_RATE = 10; // 1/s
const BASE_ELEVATION = 0.32; // rad, how far above the avatar the third-person camera sits at rest
const TP_POS_RATE = 8; // 1/s, spring lag of the camera position
const TP_LOOK_RATE = 12; // 1/s, spring lag of the look-at point
const LOOK_AHEAD = 4; // m, the camera aims this far along the avatar's look direction
const MIN_CAM_HEIGHT = 0.2;
const SWITCH_TIME = 0.3; // s, third <-> first person
const FREE_EXIT_TIME = 0.4; // s, free cam -> avatar camera
const FREE_SPEED = 6; // m/s
const FREE_SCALE = [0.5, 4];
const ACCEL_K = 10;
const TURN_RATE = THREE.MathUtils.degToRad(120);
const PITCH_LIMIT = THREE.MathUtils.degToRad(85);
const BOUND = 20;
const DEFAULT_FOCUS = 3.35; // window distance for the depth effect when nothing closer is meaningful
const UP = new THREE.Vector3(0, 1, 0);

const ease = t => t * t * (3 - 2 * t);
const rate = (k, dt) => 1 - Math.exp(-k * dt);

export class CameraRig {
  // Starts in first person: your own avatar is hidden until you switch to third person with V.
  constructor(camera, { firstPerson = true } = {}) {
    this.camera = camera;
    this.firstPerson = firstPerson;
    this.fpWeight = firstPerson ? 1 : 0; // 0 = third person, 1 = first person; eased over SWITCH_TIME
    this.freeActive = false;
    this.freeBlend = 0; // 1 while free cam is active, eases to 0 over FREE_EXIT_TIME after leaving it
    this.focus = DEFAULT_FOCUS; // distance to the depth-effect window plane

    this.tpDistance = TP_DEFAULT; // target
    this.tpShown = TP_DEFAULT; // smoothed
    this.tpPos = new THREE.Vector3();
    this.tpLook = new THREE.Vector3();
    this.tpAim = new THREE.Vector3(); // un-smoothed spring target for the look-at point (dev overlay)
    this.tpWant = new THREE.Vector3(); // un-smoothed spring target for the camera position (dev overlay)
    this._tpReady = false;

    this.free = {
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      yaw: 0,
      pitch: 0,
      vel: new THREE.Vector3(),
      turnVel: 0,
      scale: 1,
    };

    this.avatarPos = new THREE.Vector3(); // last computed avatar-camera pose, used for "snap free cam to avatar"
    this.avatarQuat = new THREE.Quaternion();
    this._fpPos = new THREE.Vector3();
    this._fpQuat = new THREE.Quaternion();
    this._tpQuat = new THREE.Quaternion();
    this._head = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  // Your own avatar is hidden only while the camera really sits in its head; in third person and free cam it shows.
  get hideAvatar() {
    return this.fpWeight > 0.6 && this.freeBlend < 0.3;
  }

  get mode() {
    return this.freeActive ? 'free cam' : this.firstPerson ? 'first person' : 'third person';
  }

  enterFree() {
    const f = this.free;
    f.pos.copy(this.camera.position);
    this._e.setFromQuaternion(this.camera.quaternion, 'YXZ');
    f.yaw = this._e.y;
    f.pitch = THREE.MathUtils.clamp(this._e.x, -PITCH_LIMIT, PITCH_LIMIT);
    f.vel.set(0, 0, 0);
    f.turnVel = 0;
    this.freeActive = true;
    this.freeBlend = 1; // starts exactly where the camera already is, so there is no jump
  }

  exitFree() {
    this.freeActive = false; // freeBlend now eases 1 -> 0, flying the camera back to the avatar's view
    this.free.vel.set(0, 0, 0);
    this.free.turnVel = 0;
  }

  // `avatar`: the locomotion state (`{pos, yaw, pitch, ...}` as arrays/numbers); `bob`: the avatar's current bob.
  update(intents, avatar, bob, dt) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    const toggles = intents.toggles;
    if (toggles.freeCam) (this.freeActive ? this.exitFree() : this.enterFree());
    if (!this.freeActive && toggles.view) this.firstPerson = !this.firstPerson;

    this._avatarPose(intents, avatar, bob, dt);
    if (this.freeActive) this._updateFree(intents, dt);

    const target = this.firstPerson ? 1 : 0;
    const step = dt / SWITCH_TIME;
    this.fpWeight += Math.sign(target - this.fpWeight) * Math.min(step, Math.abs(target - this.fpWeight));

    // Final pose: third/first person blend, then blended with the free camera while it is (or was just) active.
    const w = ease(this.fpWeight);
    const camera = this.camera;
    camera.position.lerpVectors(this.tpPos, this._fpPos, w);
    camera.quaternion.slerpQuaternions(this._tpQuat, this._fpQuat, w);
    this.avatarPos.copy(camera.position);
    this.avatarQuat.copy(camera.quaternion);

    this.freeBlend = this.freeActive ? 1 : Math.max(0, this.freeBlend - dt / FREE_EXIT_TIME);
    if (this.freeBlend > 0) {
      const b = ease(this.freeBlend);
      camera.position.lerp(this.free.pos, b);
      camera.quaternion.slerp(this.free.quat, b);
    }
    camera.updateMatrixWorld();

    const tpFocus = this.tpPos.distanceTo(this._head);
    const avatarFocus = THREE.MathUtils.lerp(tpFocus, DEFAULT_FOCUS, w);
    this.focus = THREE.MathUtils.lerp(avatarFocus, DEFAULT_FOCUS, ease(this.freeBlend));
  }

  _avatarPose(intents, avatar, bob, dt) {
    const [px, py, pz] = avatar.pos;
    const { yaw, pitch } = avatar;
    const cp = Math.cos(pitch);
    this._dir.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp); // look direction
    this._head.set(px, py + HEAD_HEIGHT + bob, pz);

    // Zoom (scroll) only drives the third-person distance while free cam isn't using the wheel.
    if (!this.freeActive) {
      this.tpDistance = THREE.MathUtils.clamp(this.tpDistance + intents.zoom * TP_ZOOM_STEP, TP_MIN, TP_MAX);
    }
    this.tpShown += (this.tpDistance - this.tpShown) * rate(TP_ZOOM_RATE, dt);

    // Third person: orbit behind and above. Looking up swings the camera down and vice versa.
    const elevation = THREE.MathUtils.clamp(BASE_ELEVATION - pitch, -0.15, 1.45);
    const ce = Math.cos(elevation);
    this.tpWant.set(Math.sin(yaw) * ce, Math.sin(elevation), Math.cos(yaw) * ce)
      .multiplyScalar(this.tpShown).add(this._head);
    this.tpWant.y = Math.max(this.tpWant.y, MIN_CAM_HEIGHT);
    this.tpAim.copy(this._head).addScaledVector(this._dir, LOOK_AHEAD);
    if (!this._tpReady) {
      this.tpPos.copy(this.tpWant);
      this.tpLook.copy(this.tpAim);
      this._tpReady = true;
    } else {
      this.tpPos.lerp(this.tpWant, rate(TP_POS_RATE, dt));
      this.tpLook.lerp(this.tpAim, rate(TP_LOOK_RATE, dt));
    }
    this.tpPos.y = Math.max(this.tpPos.y, MIN_CAM_HEIGHT);
    this._m.lookAt(this.tpPos, this.tpLook, UP);
    this._tpQuat.setFromRotationMatrix(this._m);

    // First person: at head height, looking exactly where the avatar looks.
    this._fpPos.set(px, py + EYE_HEIGHT + bob * 0.6, pz);
    this._fpQuat.setFromEuler(this._e.set(pitch, yaw, 0, 'YXZ'));
  }

  _updateFree(intents, dt) {
    const f = this.free;
    const { move, look, toggles } = intents;
    if (toggles.reset) {
      f.pos.copy(this.avatarPos);
      this._e.setFromQuaternion(this.avatarQuat, 'YXZ');
      f.yaw = this._e.y;
      f.pitch = this._e.x;
      f.vel.set(0, 0, 0);
    }
    f.scale = THREE.MathUtils.clamp(f.scale * Math.exp(-intents.zoom * 0.15), FREE_SCALE[0], FREE_SCALE[1]);

    f.turnVel += (intents.turn * TURN_RATE - f.turnVel) * rate(ACCEL_K, dt);
    f.yaw += look.dYaw + f.turnVel * dt;
    f.pitch = THREE.MathUtils.clamp(f.pitch + look.dPitch, -PITCH_LIMIT, PITCH_LIMIT);

    const cp = Math.cos(f.pitch);
    this._fwd.set(-Math.sin(f.yaw) * cp, Math.sin(f.pitch), -Math.cos(f.yaw) * cp); // forward follows the pitch
    this._right.set(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
    const t = this._t.set(0, 0, 0)
      .addScaledVector(this._fwd, move.forward)
      .addScaledVector(this._right, move.strafe)
      .addScaledVector(UP, move.vertical);
    if (t.length() > 1) t.normalize();
    t.multiplyScalar(FREE_SPEED * f.scale);
    f.vel.lerp(t, rate(ACCEL_K, dt));
    f.pos.addScaledVector(f.vel, dt);
    f.pos.x = THREE.MathUtils.clamp(f.pos.x, -BOUND, BOUND);
    f.pos.z = THREE.MathUtils.clamp(f.pos.z, -BOUND, BOUND);
    f.pos.y = THREE.MathUtils.clamp(f.pos.y, MIN_CAM_HEIGHT, BOUND);
    f.quat.setFromEuler(this._e.set(f.pitch, f.yaw, 0, 'YXZ'));
  }
}
