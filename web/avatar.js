import * as THREE from 'three';
import { advancePhase, bobAmount, footPose, FOOT_SIDE_M, stepAmount } from './gait.js';

// A simple body + head. update() takes the same snapshot a remote peer would send (`pos`, `vel`, `yaw`, `pitch`,
// `flying`) and derives the bob, lean and body turn locally, so local and remote avatars animate identically.
export const EYE_HEIGHT = 1.4;
const HEAD_HEIGHT = 1.32;
const WALK_SPEED_REF = 2; // m/s, speed at which the walk bob and lean reach their nominal size
const BODY_TURN_RATE = 8; // 1/s, how fast the body yaw eases toward the movement direction
const LEAN_RATE = 8;
const MAX_LEAN = 0.2; // radians

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);

export class Avatar {
  constructor(scene, color = 0x4c6ef5) {
    this.root = new THREE.Group();
    this.root.name = 'avatar';

    this.body = new THREE.Group();
    this.body.rotation.order = 'YXZ';
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.8, 6, 16), material);
    torso.position.y = 0.6; // spans 0 to 1.2 m, meeting the head
    this.body.add(torso);

    this.head = new THREE.Group();
    this.head.rotation.order = 'YXZ';
    this.head.position.y = HEAD_HEIGHT;
    const skull = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0xf3ede6, roughness: 0.45 }),
    );
    const visor = new THREE.Mesh( // marks which way the head faces (-z locally)
      new THREE.BoxGeometry(0.2, 0.07, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x24334a, roughness: 0.3 }),
    );
    visor.position.set(0, 0.02, -0.13);
    this.head.add(skull, visor);

    // Two floating shoes (no legs). They live in the root, which is never rotated, so offsets are world-aligned and the
    // root's bob is cancelled by `feet.position.y` to keep the soles on the floor.
    this.feet = new THREE.Group();
    const shoeMaterial = new THREE.MeshStandardMaterial({ color: 0x24334a, roughness: 0.55 });
    this.shoes = [0, 1].map(() => {
      const shoe = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), shoeMaterial);
      shoe.scale.set(0.085, 0.06, 0.15);
      shoe.rotation.order = 'YXZ';
      shoe.castShadow = true;
      this.feet.add(shoe);
      return shoe;
    });

    this.root.add(this.body, this.head, this.feet);
    for (const mesh of [torso, skull, visor]) mesh.castShadow = true;
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
}
