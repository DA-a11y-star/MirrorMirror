import * as THREE from 'three';
import { advancePhase, bobAmount, footPose, FOOT_SIDE_M, STANCE, STRIDE_M, stepAmount } from './gait.js';

// A simple body + head. update() takes the same snapshot a remote peer would send (`pos`, `vel`, `yaw`, `pitch`,
// `flying`) and derives the bob, lean and body turn locally, so local and remote avatars animate identically.
export const EYE_HEIGHT = 1.4;
const HEAD_HEIGHT = 1.32;
const WALK_SPEED_REF = 2; // m/s, speed at which the walk bob and lean reach their nominal size
const BODY_TURN_RATE = 8; // 1/s, how fast the body yaw eases toward the movement direction
const LEAN_RATE = 8;
const MAX_LEAN = 0.2; // radians

const GLOVE_SIDE_M = 0.34; // gloves hang this far to each side of the torso
const GLOVE_SWING_M = 0.15; // how far a glove swings fore and aft while walking, opposite to the foot on its side
const INK = new THREE.MeshBasicMaterial({ color: 0x0b0b12, side: THREE.BackSide });

// Adds the thick black outline: the same geometry again, a little bigger and drawn inside out in flat black.
function toon(mesh, thickness = 0.07) {
  const outline = new THREE.Mesh(mesh.geometry, INK);
  outline.scale.setScalar(1 + thickness);
  mesh.add(outline);
  mesh.castShadow = true;
  return mesh;
}

// A unit sphere whose lower half narrows to a chin, like the drawing's head: wide at the top, pointed below.
function chinGeometry() {
  const geometry = new THREE.SphereGeometry(1, 28, 20);
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 0) {
      const k = -y;
      p.setX(i, p.getX(i) * (1 - 0.34 * k));
      p.setZ(i, p.getZ(i) * (1 - 0.22 * k));
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Avatar {
  constructor(scene, color = 0x4c6ef5) {
    this.root = new THREE.Group();
    this.root.name = 'avatar';

    // Cartoon style: a big head with a pointed chin and no neck, a floating rounded torso, floating white gloves and
    // floating shoes, all with a thick black outline (an inverted hull). No arms or legs, so none need animating.
    this.body = new THREE.Group();
    this.body.rotation.order = 'YXZ';
    const suit = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    const torso = toon(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), suit));
    torso.scale.set(0.2, 0.25, 0.17);
    torso.position.y = 0.84; // just below the chin: head and torso touch, with no neck between them
    this.body.add(torso);

    const glove = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    this.gloves = [-1, 1].map(side => {
      const hand = new THREE.Group();
      hand.userData.rest = new THREE.Vector3(side * GLOVE_SIDE_M, 0.8, 0);
      hand.position.copy(hand.userData.rest);
      const palm = toon(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), glove));
      palm.scale.setScalar(0.095);
      const thumb = toon(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), glove));
      thumb.scale.setScalar(0.045);
      thumb.position.set(side * -0.07, 0.05, -0.07);
      hand.add(palm, thumb);
      this.body.add(hand);
      return hand;
    });

    this.head = new THREE.Group();
    this.head.rotation.order = 'YXZ';
    this.head.position.y = HEAD_HEIGHT;
    const skull = toon(new THREE.Mesh(chinGeometry(), new THREE.MeshStandardMaterial({ color: 0xf3ede6, roughness: 0.5 })), 0.05);
    skull.scale.set(0.27, 0.25, 0.24);
    const ink = new THREE.MeshBasicMaterial({ color: 0x0b0b12 });
    this.eyes = [-1, 1].map(side => {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), ink);
      eye.scale.set(0.02, 0.05, 0.016);
      eye.position.set(side * 0.085, 0.045, -0.215); // on the -z face, poking just out of the skull
      eye.rotation.z = side * 0.22; // a little tilt so the face has a mood
      this.head.add(eye);
      return eye;
    });
    const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), ink);
    nose.scale.setScalar(0.024);
    nose.position.set(0, -0.045, -0.222);
    this.head.add(skull, nose);

    // Two floating shoes (no legs). They live in the root, which is never rotated, so offsets are world-aligned and the
    // root's bob is cancelled by `feet.position.y` to keep the soles on the floor.
    this.feet = new THREE.Group();
    const shoeMaterial = new THREE.MeshStandardMaterial({ color: 0x24334a, roughness: 0.55 });
    this.shoes = [0, 1].map(() => {
      const shoe = toon(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), shoeMaterial));
      shoe.scale.set(0.1, 0.06, 0.17);
      shoe.rotation.order = 'YXZ';
      this.feet.add(shoe);
      return shoe;
    });

    this.root.add(this.body, this.head, this.feet);
    scene.add(this.root);

    this.bodyYaw = 0;
    this.bob = 0; // vertical offset in meters, also read by the first-person camera
    this.leanForward = 0;
    this.leanSide = 0;
    this.phase = 0; // stride cycles; foot 0 leads, foot 1 is half a cycle behind
    this.dir = new THREE.Vector2(0, -1); // last direction of travel on the floor (x, z), kept while standing
    this.air = 0; // 0 on the floor, 1 when flying clear of it: the shoes dangle instead of stepping
    this.time = 0;
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
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
    this.air += (THREE.MathUtils.clamp((state.pos[1] - 0.05) / 0.25, 0, 1) - this.air) * ease(10, dt);
    const amount = stepAmount(speed) * (1 - this.air);
    this.phase = advancePhase(this.phase, speed * (1 - this.air), dt);
    this.bob = bobAmount(this.phase, amount);
    if (speed > 0.05) this.dir.set(vx / speed, vz / speed);
    this._placeShoes(state, amount);
    this._swingGloves(amount);
    this._blink(dt);

    this.root.position.set(state.pos[0], state.pos[1] + this.bob, state.pos[2]);
    this.head.rotation.set(state.pitch, state.yaw, 0);
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
      shoe.rotation.set(-Math.min(lift / 0.13, 1) * 0.25 * amount, this.bodyYaw, 0); // toe tips up as it swings
    });
  }

  // Each glove swings opposite to the foot on its side, and hangs still at rest.
  _swingGloves(amount) {
    const half = (STRIDE_M * STANCE) / 2;
    this.gloves.forEach((hand, i) => {
      const { f, lift } = footPose(this.phase + i * 0.5);
      hand.position.copy(hand.userData.rest);
      hand.position.z += (f / half) * GLOVE_SWING_M * amount; // forward is -z: a foot going forward pulls its glove back
      hand.position.y += lift * 0.35 * amount;
    });
  }

  // Occasional quick blink.
  _blink(dt) {
    this.blinkIn = (this.blinkIn ?? 2) - dt;
    if (this.blinkIn < 0) this.blinkClock = 0.13, this.blinkIn = 2 + Math.random() * 3.5;
    this.blinkClock = Math.max(0, (this.blinkClock ?? 0) - dt);
    const shut = this.blinkClock > 0 ? Math.sin(Math.PI * (1 - this.blinkClock / 0.13)) : 0;
    for (const eye of this.eyes) eye.scale.y = 0.05 * (1 - 0.9 * shut);
  }
}
