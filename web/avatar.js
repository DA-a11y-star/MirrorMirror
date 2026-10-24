import * as THREE from 'three';

// The other user: a floating bust at their eye position, a head that turns with theirs, and their hands. Each
// laptop sends its own base camera pose, so the avatar sits wherever that user's view is.
const STALE_MS = 700;   // a peer that stops sending disappears
const FOLLOW_RATE = 21; // 1/s; eases 30 Hz updates into 60 fps motion, the same as remote blocks
const HEAD_RADIUS = 0.11;
const TORSO_DROP = 0.52; // eye height to the middle of the torso
const BODY = 0x4c6ef5;
const SKIN = 0xf3ede6;
const VISOR = 0x24334a;

// The one place that maps the tracker's head rotation into the world. The tracker works on the mirrored webcam
// image (x toward the user's right, y down, z toward the user), which is a reflection of the viewer's camera
// frame (x right, y up, z toward the viewer), so the rotation is conjugated by the y flip: (x, y, z, w) ->
// (-x, y, -z, w). A frontal face is the identity. Derived from the tracker's conventions, not yet checked
// against a real head: if the avatar turns the wrong way, fix it here.
export function headQuaternion(q, out = new THREE.Quaternion()) {
  return out.set(-q[0], q[1], -q[2], q[3]);
}

export class RemoteAvatar {
  // `hands` is a Hands instance reserved for this user; their landmarks are drawn through their own seat.
  constructor(scene, user, hands) {
    this.user = user;
    this.hands = hands;
    this.seat = new THREE.Object3D(); // the user's base camera: where they sit and which way they look
    this.targetPos = new THREE.Vector3();
    this.targetQuat = new THREE.Quaternion();
    this.headTarget = new THREE.Quaternion(); // head rotation relative to the seat
    this.headRel = new THREE.Quaternion();
    this.euler = new THREE.Euler();
    this.targetBlock = null; // latest id they reported looking at
    this.looking = null; // the same, but null while the avatar is gone
    this.lastSeen = -Infinity;
    this.fresh = true;

    this.root = new THREE.Group();
    this.root.visible = false;
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.45, 6, 16),
      new THREE.MeshStandardMaterial({ color: BODY, roughness: 0.6 }));
    this.head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 24, 16),
      new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.5 }));
    // The visor sits on the -z side: the head faces down its own -z, like a camera, when the rotation is the identity.
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.045, 0.05),
      new THREE.MeshStandardMaterial({ color: VISOR, roughness: 0.3 }));
    visor.position.set(0, 0.01, -HEAD_RADIUS * 0.88);
    this.head.add(skull, visor);
    for (const mesh of [this.torso, skull, visor]) mesh.castShadow = true;
    this.root.add(this.torso, this.head);
    scene.add(this.seat, this.root);
  }

  // A validated `state` message from this user.
  setState(msg, now) {
    this.targetPos.fromArray(msg.avatar.pos);
    this.targetQuat.fromArray(msg.avatar.quat).normalize();
    if (msg.head) headQuaternion(msg.head.quat, this.headTarget).normalize();
    else this.headTarget.identity();
    this.hands.setFrame(msg.hands);
    this.targetBlock = msg.target ?? null;
    this.lastSeen = now;
  }

  get live() {
    return this.root.visible;
  }

  update(dt, now) {
    if (now - this.lastSeen > STALE_MS) {
      if (this.root.visible) {
        this.root.visible = false;
        this.hands.setFrame([]);
        this.fresh = true;
      }
      this.looking = null;
      this.hands.update(dt, this.seat);
      return;
    }
    const k = 1 - Math.exp(-FOLLOW_RATE * dt);
    if (this.fresh) {
      this.seat.position.copy(this.targetPos);
      this.seat.quaternion.copy(this.targetQuat);
      this.headRel.copy(this.headTarget);
      this.fresh = false;
    } else {
      this.seat.position.lerp(this.targetPos, k);
      this.seat.quaternion.slerp(this.targetQuat, k);
      this.headRel.slerp(this.headTarget, k);
    }
    this.seat.updateMatrixWorld();
    this.head.position.copy(this.seat.position);
    this.head.quaternion.copy(this.seat.quaternion).multiply(this.headRel);
    // The body turns with the user's view but not with its pitch or their head.
    this.torso.position.set(this.seat.position.x, this.seat.position.y - TORSO_DROP, this.seat.position.z);
    this.torso.rotation.set(0, this.euler.setFromQuaternion(this.seat.quaternion, 'YXZ').y, 0);
    this.root.visible = true;
    this.looking = this.targetBlock;
    this.hands.update(dt, this.seat);
  }
}
