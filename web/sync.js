import * as THREE from 'three';

// Ownership and scene sync for the shared blocks (rules in CLAUDE.md):
// - Whoever grabs a block owns it and streams its transform in `held`; everyone else only renders it.
// - The host (laptop A) is the scene authority. It follows the holder's stream and broadcasts every block at
//   10 Hz, so a laptop that reloads or joins late catches up within 100 ms.
const SCENE_HZ = 10;
const FOLLOW_RATE = 21;    // 1/s; the same easing as `+= (target - pos) * .3` per frame at 60 fps, at any frame rate
const SETTLE_MS = 400;     // host snapshots sent before our release arrived must not pull the block back
const PEER_STALE_MS = 700; // a laptop that goes quiet loses its holds

export const round = v => Math.round(v * 1e4) / 1e4;

export class SceneSync {
  constructor(blocks, { userId, hostId = 'A' }) {
    this.blocks = blocks;
    this.userId = userId;
    this.hostId = hostId;
    this.isHost = userId === hostId;
    this.meshes = new Map(blocks.children.map(mesh => [mesh.userData.id, mesh]));
    this.holders = new Map();    // block id -> user holding it (never this laptop)
    this.seen = new Map();       // user -> when their last state arrived
    this.targets = new Map();    // block id -> pose a block owned by someone else is easing toward
    this.releasedAt = new Map(); // block id -> when this laptop last let go of it
    this.mine = new Set();       // ids this laptop held last frame
    this.lastScene = -Infinity;
  }

  setTarget(id, pos, quat) {
    const target = this.targets.get(id) ?? { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    target.pos.fromArray(pos);
    target.quat.fromArray(quat).normalize();
    this.targets.set(id, target);
  }

  // Another laptop's full snapshot. `mine` is the set of block ids this laptop is holding. Returns the ids this
  // laptop must let go of: both grabbed the same block in the same instant and the lower user id keeps it.
  applyState(msg, now, mine) {
    this.seen.set(msg.user, now);
    const lost = [];
    const holding = new Set();
    for (const { id, pos, quat } of msg.held) {
      if (!this.meshes.has(id)) continue;
      if (mine.has(id)) {
        if (msg.user > this.userId) continue; // we keep it; they will see our claim and let go
        lost.push(id);
      }
      holding.add(id);
      this.holders.set(id, msg.user);
      this.setTarget(id, pos, quat);
    }
    for (const [id, user] of this.holders) if (user === msg.user && !holding.has(id)) this.holders.delete(id);
    return lost;
  }

  // The host's snapshot of every block. Only blocks nobody is holding follow it.
  applyScene(msg, now, mine) {
    if (this.isHost || msg.user !== this.hostId) return;
    for (const { id, pos, quat } of msg.objects) {
      if (!this.meshes.has(id) || mine.has(id) || this.holders.has(id)) continue;
      if (now - (this.releasedAt.get(id) ?? -Infinity) < SETTLE_MS) continue;
      this.setTarget(id, pos, quat);
    }
  }

  // Once per frame. Eases blocks other people own toward their latest pose.
  update(dt, now, mine) {
    for (const id of this.mine) if (!mine.has(id)) this.releasedAt.set(id, now);
    this.mine = mine;
    for (const [user, at] of this.seen) {
      if (now - at <= PEER_STALE_MS) continue;
      this.seen.delete(user);
      for (const [id, holder] of this.holders) if (holder === user) this.holders.delete(id);
    }
    const k = 1 - Math.exp(-FOLLOW_RATE * dt);
    for (const [id, target] of this.targets) {
      if (mine.has(id)) { // we grabbed it: it is ours now
        this.targets.delete(id);
        continue;
      }
      const mesh = this.meshes.get(id);
      mesh.position.lerp(target.pos, k);
      mesh.quaternion.slerp(target.quat, k);
      if (!this.holders.has(id) && mesh.position.distanceToSquared(target.pos) < 1e-8 && mesh.quaternion.angleTo(target.quat) < 1e-4) {
        mesh.position.copy(target.pos);
        mesh.quaternion.copy(target.quat);
        this.targets.delete(id);
      }
    }
  }

  // Transforms of the blocks this laptop holds, for the `held` field of its state message.
  snapshotHeld(mine) {
    // Voice assemblies are local in this milestone. They share the interaction container but are not relay
    // blocks; don't look up an absent mesh or advertise ownership of an object the other laptop cannot render.
    return [...mine].filter(id => this.meshes.has(id)).map(id => {
      const mesh = this.meshes.get(id);
      return { id, pos: mesh.position.toArray().map(round), quat: mesh.quaternion.toArray().map(round) };
    });
  }

  // The host's scene message when one is due, otherwise null. Objects are created and removed by ops (voice-to-CAD).
  sceneSnapshot(now) {
    if (!this.isHost || now - this.lastScene < 1000 / SCENE_HZ) return null;
    this.lastScene = now;
    return {
      type: 'scene',
      objects: [...this.meshes].map(([id, mesh]) => ({
        id, kind: 'box', pos: mesh.position.toArray().map(round), quat: mesh.quaternion.toArray().map(round),
        scale: mesh.scale.toArray(), color: mesh.material.color.getHex(),
      })),
    };
  }
}
