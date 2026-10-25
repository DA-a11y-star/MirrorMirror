import * as THREE from 'three';
import { advancePhase, bobAmount, footPose, FOOT_SIDE_M, LIFT_M, stepAmount } from './gait.js';

// A simple body + head. update() takes the same snapshot a remote peer would send (`pos`, `vel`, `yaw`, `pitch`,
// `flying`) and derives the bob, lean and body turn locally, so local and remote avatars animate identically.
export const EYE_HEIGHT = 1.4;
const HEAD_R = 0.16;
const FACE_K = HEAD_R / 0.22; // the face was laid out for a 0.22 head; it scales with the head
const HEAD_Y = 0.33 + HEAD_R; // centre of the head above the feet: sits right on the belly, no neck
const BELLY_R = 0.18;
const WALK_SPEED_REF = 2; // m/s, speed at which the walk bob and lean reach their nominal size
const BODY_TURN_RATE = 8; // 1/s, how fast the body yaw eases toward the movement direction
const LEAN_RATE = 8;
const HEAD_FOLLOW_RATE = 12; // 1/s: how quickly the head eases toward your real head's turn (the remote avatar uses the same ease)
const MAX_LEAN = 0.2; // radians

// The two ball hands follow where your real hands are (their position, not the fingers). Landmarks are webcam-space
// metres: x to your right, y down, z away from the webcam toward you. The hand sits in the avatar's view frame (turns
// with where it looks), in front of its belly, and never farther from the belly than HAND_REACH.
// Raise a number to make that effect bigger, lower it to shrink it.
export const HAND_SIDE_M = 0.27; // m: resting hands hang this far to each side of the belly
export const HAND_REST_Y = 0.34; // m above the feet: the resting hand height (about belly level), also the vertical zero for tracked hands
const HAND_GAIN = 1.5; // avatar metres per real metre, for sideways and up/down motion: 1 = hands move exactly as far as yours
const HAND_FORWARD_M = 0.4; // m: how far in front of the belly a hand held at HAND_REF_Z sits
const HAND_REF_Z = 0.45; // m from the webcam: the real hand distance treated as "neutral"; nearer than this reaches forward, farther pulls back
const HAND_DEPTH_GAIN = 1.5; // avatar metres per real metre toward or away from the webcam (the same idea as HAND_GAIN, for depth)
export const HAND_REACH = 1.5; // m: a hand is never drawn farther than this from the belly, however far the real hand reaches
const HAND_HOLD_S = 0.4; // s: a hand that stops arriving is kept this long (tracker dropouts), then it goes back to rest
const HAND_RATE = 13; // 1/s easing toward the target: higher is snappier and jitterier, lower is smoother and laggier
const PALM = [0, 5, 9, 13, 17]; // MediaPipe landmarks of the palm (wrist and the four finger knuckles); their average is the hand's position

// Where the ball for `side` should be, from a tracked hand's 21 landmarks. Writes into `out` {x, y, z} (view frame,
// before the avatar's yaw; the avatar faces -z) and returns it, or null for broken landmarks.
export function handTarget(lm, side, out = {}) {
  if (!Array.isArray(lm) || lm.length < 21 || !PALM.every(i => Array.isArray(lm[i]) && lm[i].slice(0, 3).every(Number.isFinite))) return null;
  let x = 0, y = 0, z = 0;
  for (const i of PALM) { x += lm[i][0]; y += lm[i][1]; z += lm[i][2]; }
  x /= PALM.length; y /= PALM.length; z /= PALM.length;
  let ox = x * HAND_GAIN;
  let oy = -y * HAND_GAIN;
  let oz = (z - HAND_REF_Z) * HAND_DEPTH_GAIN - HAND_FORWARD_M;
  const len = Math.hypot(ox, oy, oz);
  if (len > HAND_REACH) { // out past the reach: same direction, stop at the reach
    const k = HAND_REACH / len;
    ox *= k; oy *= k; oz *= k;
  }
  out.x = (side === 'left' ? -HAND_SIDE_M * 0.5 : HAND_SIDE_M * 0.5) + ox;
  out.y = HAND_REST_Y + oy;
  out.z = oz;
  return out;
}
const INK = new THREE.MeshBasicMaterial({ color: 0x0b0b12, side: THREE.BackSide });

// Adds the thick black outline: the same geometry again, a little bigger and drawn inside out in flat black.
function toon(mesh, thickness = 0.07) {
  const outline = new THREE.Mesh(mesh.geometry, INK);
  outline.scale.setScalar(1 + thickness);
  mesh.add(outline);
  mesh.castShadow = true;
  return mesh;
}

const IDENTITY = new THREE.Quaternion();
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Avatar {
  constructor(scene, color = 0x4c6ef5) {
    this.root = new THREE.Group();
    this.root.name = 'avatar';

    // Short and round, like Kirby: a sphere belly, a sphere head sitting right on it (no neck), two round hands and two
    // little shoes tucked under the belly, all with a thick black outline (an inverted hull). No arms or legs.
    this.body = new THREE.Group();
    this.body.rotation.order = 'YXZ';
    const suit = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    const belly = toon(new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), suit));
    belly.scale.setScalar(BELLY_R);
    belly.position.y = 0.06 + BELLY_R; // resting just above the shoes
    this.body.add(belly);

    // Ball hands: a palm and a thumb, white. They live in a group that turns with the view yaw (not the body), because
    // your hands are in your view. Resting at the sides, or following your tracked hands (setHands).
    this.handsGroup = new THREE.Group();
    const glove = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    this.gloves = [-1, 1].map(side => {
      const hand = new THREE.Group();
      hand.userData.rest = new THREE.Vector3(side * HAND_SIDE_M, HAND_REST_Y, 0);
      hand.userData.target = hand.userData.rest.clone();
      hand.userData.seenAt = -Infinity;
      hand.position.copy(hand.userData.rest);
      const palm = toon(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), glove));
      palm.scale.setScalar(0.07);
      const thumb = toon(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), glove));
      thumb.scale.setScalar(0.034);
      thumb.position.set(side * -0.055, 0.035, -0.05);
      hand.add(palm, thumb);
      this.handsGroup.add(hand);
      return hand;
    });

    this.head = new THREE.Group();
    this.head.rotation.order = 'YXZ';
    this.head.position.y = HEAD_Y;
    const skull = toon(new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), new THREE.MeshStandardMaterial({ color: 0xf3ede6, roughness: 0.5 })), 0.05);
    skull.scale.setScalar(HEAD_R);
    // The face sits low on the head, which is what makes it cute: small wide-set eyes and a dot of a nose.
    const ink = new THREE.MeshBasicMaterial({ color: 0x0b0b12 });
    this.eyes = [-1, 1].map(side => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), ink);
      eye.scale.set(0.017 * FACE_K, 0.04 * FACE_K, 0.014 * FACE_K);
      eye.userData.height = 0.04 * FACE_K;
      eye.position.set(side * 0.078 * FACE_K, -0.035 * FACE_K, -0.2 * FACE_K); // on the -z face, poking just out of the skull
      eye.rotation.z = side * 0.1;
      this.head.add(eye);
      return eye;
    });
    const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), ink);
    nose.scale.setScalar(0.017 * FACE_K);
    nose.position.set(0, -0.09 * FACE_K, -0.2 * FACE_K);
    this.head.add(skull, nose);

    // Two floating shoes (no legs), right under the belly. They live in the root, which is never rotated, so offsets are
    // world-aligned and the root's bob is cancelled by `feet.position.y` to keep the soles on the floor.
    this.feet = new THREE.Group();
    const shoeMaterial = new THREE.MeshStandardMaterial({ color: 0x24334a, roughness: 0.55 });
    this.shoes = [0, 1].map(() => {
      const shoe = toon(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), shoeMaterial));
      shoe.scale.set(0.085, 0.06, 0.14);
      shoe.rotation.order = 'YXZ';
      this.feet.add(shoe);
      return shoe;
    });

    this.root.add(this.body, this.head, this.feet, this.handsGroup);
    scene.add(this.root);

    this.floorAt = () => 0; // (x, z) => floor height, set by the world
    this.bodyYaw = 0;
    this.headRel = new THREE.Quaternion();   // the real head's turn relative to the view, eased
    this._headGoal = new THREE.Quaternion(); // where headRel is heading (identity = looking straight along the view)
    this._headEuler = new THREE.Euler();
    this.bob = 0; // vertical offset in meters, also read by the first-person camera
    this.leanForward = 0;
    this.leanSide = 0;
    this.phase = 0; // stride cycles; foot 0 leads, foot 1 is half a cycle behind
    this.dir = new THREE.Vector2(0, -1); // last direction of travel on the floor (x, z), kept while standing
    this.air = 0; // 0 on the floor, 1 when flying clear of it: the shoes dangle instead of stepping
    this.time = 0;
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._hand = {};
  }

  // The tracker's head rotation, already mapped to the world (headQuaternion in remote-avatar.js), or null when there is
  // none: the head then settles back to following the view. It adds to the view direction, so turning your head turns
  // the avatar's head the same way, on your own avatar and (through the state message) on the other laptop.
  setHeadTurn(quat) {
    if (quat) this._headGoal.copy(quat).normalize();
    else this._headGoal.identity();
  }

  setHeadVisible(visible) {
    this.head.visible = visible;
  }

  // The whole avatar (body, head and shadow): hidden from its own owner in first person.
  setVisible(visible) {
    this.root.visible = visible;
  }

  update(state, dt) {
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.time += dt;
    const [vx, , vz] = state.vel;
    const speed = Math.hypot(vx, vz);
    const moving = THREE.MathUtils.clamp(speed / WALK_SPEED_REF, 0, 1.5);

    // Body turn: face the way you move, folded so that walking backwards doesn't spin the avatar around.
    this._f.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    this._r.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
    let rel = Math.atan2(-(vx * this._r.x + vz * this._r.z), vx * this._f.x + vz * this._f.z);
    if (Math.abs(rel) > Math.PI / 2) rel -= Math.sign(rel) * Math.PI;
    const weight = THREE.MathUtils.clamp((speed - 0.2) / 0.8, 0, 1);
    const target = state.yaw + rel * 0.6 * weight;
    this.bodyYaw = wrap(this.bodyYaw + wrap(target - this.bodyYaw) * ease(BODY_TURN_RATE, dt));

    // Lean into the motion, measured in the body's own frame.
    const bf = -Math.sin(this.bodyYaw);
    const bz = -Math.cos(this.bodyYaw);
    const forward = (vx * bf + vz * bz) / WALK_SPEED_REF;
    const side = (vx * Math.cos(this.bodyYaw) + vz * -Math.sin(this.bodyYaw)) / WALK_SPEED_REF;
    const k = ease(LEAN_RATE, dt);
    this.leanForward += (THREE.MathUtils.clamp(forward, -1, 1) * MAX_LEAN - this.leanForward) * k;
    this.leanSide += (THREE.MathUtils.clamp(side, -1, 1) * MAX_LEAN - this.leanSide) * k;
    this.body.rotation.set(-this.leanForward, this.bodyYaw, -this.leanSide);

    // Procedural walk: the stride phase follows distance travelled, so planted shoes stay planted.
    const aboveFloor = state.pos[1] - this.floorAt(state.pos[0], state.pos[2]); // standing on a deck is not flying
    this.air += (THREE.MathUtils.clamp((aboveFloor - 0.05) / 0.25, 0, 1) - this.air) * ease(10, dt);
    const amount = stepAmount(speed) * (1 - this.air);
    this.phase = advancePhase(this.phase, speed * (1 - this.air), dt);
    this.bob = bobAmount(this.phase, amount);
    if (speed > 0.05) this.dir.set(vx / speed, vz / speed);
    this._placeShoes(state, amount);
    this._updateGloves(state, dt);
    this._blink(dt);

    this.root.position.set(state.pos[0], state.pos[1] + this.bob, state.pos[2]);
    this.headRel.slerp(this._headGoal, ease(HEAD_FOLLOW_RATE, dt));
    if (this.headRel.angleTo(IDENTITY) > 1e-4) {
      this.head.quaternion.setFromEuler(this._headEuler.set(state.pitch, state.yaw, 0, 'YXZ')).multiply(this.headRel);
    } else {
      this.head.rotation.set(state.pitch, state.yaw, 0); // no head turn: exactly the view, as before
    }
  }

  _placeShoes(state, amount) {
    const rx = Math.cos(this.bodyYaw); // body's right
    const rz = -Math.sin(this.bodyYaw);
    const [vx, , vz] = state.vel;
    this.feet.position.y = -this.bob;
    this.shoes.forEach((shoe, i) => {
      const { f, lift } = footPose(this.phase + i * 0.5);
      const side = (i === 0 ? -1 : 1) * FOOT_SIDE_M;
      // Stepping shrinks to nothing at rest, so standing shoes sit side by side under the body.
      const x = this.dir.x * f * amount + rx * side - vx * 0.05 * this.air; // flying: shoes trail the motion
      const z = this.dir.y * f * amount + rz * side - vz * 0.05 * this.air;
      const y = 0.06 + lift * amount + 0.05 * this.air; // 0.06 = shoe half height, so the sole rests on the floor
      shoe.position.set(x, y, z);
      shoe.rotation.set(-Math.min(lift / LIFT_M, 1) * 0.25 * amount, this.bodyYaw, 0); // toe tips up as it swings
    });
  }

  // `hands` is the tracker's [{side, lm}] (yours) or a peer's state `hands`: the balls follow where those hands are.
  setHands(hands) {
    for (const hand of Array.isArray(hands) ? hands : []) {
      const ball = this.gloves[hand?.side === 'left' ? 0 : hand?.side === 'right' ? 1 : -1];
      if (!ball) continue;
      // `rest` is set in MOVE mode while that hand's stick is not engaged (a fist, or recentring): the ball goes back
      // to its resting spot at the side. Otherwise it follows where the hand is.
      if (hand.rest === true) ball.userData.target.copy(ball.userData.rest);
      else if (handTarget(hand.lm, hand.side, this._hand)) ball.userData.target.set(this._hand.x, this._hand.y, this._hand.z);
      else continue;
      ball.userData.seenAt = this.time;
    }
  }

  _updateGloves(state, dt) {
    this.handsGroup.rotation.y = state.yaw;
    const k = ease(HAND_RATE, dt);
    for (const ball of this.gloves) {
      const tracked = this.time - ball.userData.seenAt < HAND_HOLD_S;
      ball.position.lerp(tracked ? ball.userData.target : ball.userData.rest, k);
    }
  }

  // Occasional quick blink.
  _blink(dt) {
    this.blinkIn = (this.blinkIn ?? 2) - dt;
    if (this.blinkIn < 0) this.blinkClock = 0.13, this.blinkIn = 2 + Math.random() * 3.5;
    this.blinkClock = Math.max(0, (this.blinkClock ?? 0) - dt);
    const shut = this.blinkClock > 0 ? Math.sin(Math.PI * (1 - this.blinkClock / 0.13)) : 0;
    for (const eye of this.eyes) eye.scale.y = eye.userData.height * (1 - 0.9 * shut);
  }
}
