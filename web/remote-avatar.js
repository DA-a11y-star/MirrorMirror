import * as THREE from 'three';

// The other user. Their body is the same Avatar that you walk with (avatar.js), driven by the snapshot their laptop
// sends (`pos`, `vel`, `yaw`, `pitch`, `flying`). What only the relay adds is drawn here: their head turn from the
// tracker, their hands, and which block they are looking at.
const STALE_MS = 700;   // a peer that stops sending disappears
const FOLLOW_RATE = 21; // 1/s; eases 30 Hz updates into 60 fps motion, the same as remote blocks

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// The one place that maps the tracker's head rotation into the world. The tracker works on the mirrored webcam
// image (x toward the user's right, y down, z toward the user), which is a reflection of the viewer's camera
// frame (x right, y up, z toward the viewer), so the rotation is conjugated by the y flip: (x, y, z, w) ->
// (-x, y, -z, w). A frontal face is the identity. Derived from the tracker's conventions, not yet checked
// against a real head: if the avatar turns the wrong way, fix it here.
export function headQuaternion(q, out = new THREE.Quaternion()) {
  return out.set(-q[0], q[1], -q[2], q[3]);
}

export class RemoteAvatar {
  // `body` is an Avatar and `hands` a Hands instance, both reserved for this user. `eyeHeight` is how far their eyes
  // are above their feet: their landmarks are drawn from where they see, the way yours are in first person.
  constructor(user, body, hands, eyeHeight) {
    this.user = user;
    this.body = body;
    this.hands = hands;
    this.eyeHeight = eyeHeight;
    this.seat = new THREE.Object3D(); // their eye frame: where they stand and which way they look
    this.seat.rotation.order = 'YXZ';
    this.target = null; // latest snapshot: { pos, vel, yaw, pitch, flying }
    this.shown = { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, flying: false };
    this.headTarget = new THREE.Quaternion(); // head rotation relative to their view
    this.headRel = new THREE.Quaternion();
    this.targetBlock = null; // latest id they reported looking at
    this.looking = null; // the same, but null while the avatar is gone
    this.lastSeen = -Infinity;
    this.fresh = true;
    this.live = false;
    body.setVisible(false);
  }

  // A validated `state` message from this user.
  setState(msg, now) {
    this.target = msg.avatar;
    if (msg.head) headQuaternion(msg.head.quat, this.headTarget).normalize();
    else this.headTarget.identity();
    this.hands.setFrame(msg.hands);
    this.targetBlock = msg.target ?? null;
    this.lastSeen = now;
  }

  update(dt, now) {
    if (!this.target || now - this.lastSeen > STALE_MS) {
      if (this.live) {
        this.live = false;
        this.body.setVisible(false);
        this.hands.setFrame([]);
        this.fresh = true;
      }
      this.looking = null;
      this.hands.update(dt, this.seat);
      return;
    }
    const { shown, target } = this;
    const k = 1 - Math.exp(-FOLLOW_RATE * dt);
    if (this.fresh) {
      shown.pos = [...target.pos];
      shown.vel = [...target.vel];
      shown.yaw = target.yaw;
      shown.pitch = target.pitch;
      this.headRel.copy(this.headTarget);
      this.fresh = false;
    } else {
      for (let i = 0; i < 3; i++) {
        shown.pos[i] += (target.pos[i] - shown.pos[i]) * k;
        shown.vel[i] += (target.vel[i] - shown.vel[i]) * k;
      }
      shown.yaw = wrap(shown.yaw + wrap(target.yaw - shown.yaw) * k);
      shown.pitch += (target.pitch - shown.pitch) * k;
      this.headRel.slerp(this.headTarget, k);
    }
    shown.flying = target.flying;
    this.body.update(shown, dt);
    this.body.setVisible(true);
    this.seat.position.set(shown.pos[0], shown.pos[1] + this.eyeHeight + this.body.bob, shown.pos[2]);
    this.seat.rotation.set(shown.pitch, shown.yaw, 0);
    this.seat.updateMatrixWorld();
    // Their head faces where they look; their own head turn (from the tracker) adds to that.
    this.body.head.quaternion.copy(this.seat.quaternion).multiply(this.headRel);
    this.live = true;
    this.looking = this.targetBlock;
    this.hands.update(dt, this.seat);
  }
}
