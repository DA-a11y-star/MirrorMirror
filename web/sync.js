import * as THREE from 'three';
import { MAX_OBJECTS, renderSpec } from './object-protocol.js';

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
  constructor(blocks, { userId, hostId = 'A', objects = null }) {
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
    this.objects = objects;
    this.pending = new Map(); // generated id -> add/delete, retried until the host's scene acknowledges it
    this.deleted = new Set(); // host tombstones prevent delayed add retries from resurrecting deleted assemblies
    this.acks = new Set(); // operation ids accepted by the host; snapshots acknowledge exact edits, not guessed poses
    this.opSeq = Date.now();
    if (objects) {
      objects.onAdd = root => {
        this.meshes.set(root.userData.id, root);
        this.pending.set(root.userData.id, { opId: `${this.userId}:${++this.opSeq}`, op: 'add', obj: this.assemblySnapshot(root), sentAt: -Infinity });
        this.lastScene = -Infinity;
      };
      objects.onRemove = root => {
        const id = root.userData.id;
        this.forget(id);
        if (this.isHost) this.deleted.add(id);
        this.pending.set(id, { opId: `${this.userId}:${++this.opSeq}`, op: 'delete', obj: { id }, sentAt: -Infinity });
        this.lastScene = -Infinity;
      };
    }
  }

  assemblySnapshot(root) {
    return { id: root.userData.id, kind: 'assembly', spec: renderSpec(root.userData.spec),
      pos: root.position.toArray(), quat: root.quaternion.toArray(), scale: root.scale.toArray() };
  }

  forget(id) {
    this.meshes.delete(id);
    this.holders.delete(id);
    this.targets.delete(id);
    this.releasedAt.delete(id);
    this.mine.delete(id);
  }

  removeAssembly(id) {
    if (!this.meshes.get(id)?.userData.spec) return;
    this.objects?.remove(id, { notify: false });
    this.forget(id);
  }

  receiveAssembly(obj) {
    if (!this.objects || this.meshes.has(obj.id) || this.meshes.size >= MAX_OBJECTS) return;
    const root = this.objects.add({ ...obj.spec, position: obj.pos, quaternion: obj.quat },
      { place: false, remember: false, notify: false });
    root.scale.fromArray(obj.scale);
    this.meshes.set(obj.id, root);
  }

  applyOp(msg) {
    // Guests display their own result immediately; only the host accepts other guests' edits into the shared scene.
    if (!this.isHost && msg.user !== this.hostId) return;
    if (this.isHost) this.acks.add(msg.opId);
    const id = msg.obj.id;
    if (msg.op === 'add') {
      if (this.deleted.has(id) || this.meshes.has(id)) return;
      if (this.meshes.size >= MAX_OBJECTS) this.deleted.add(id);
      else this.receiveAssembly(msg.obj);
    } else if (msg.op === 'delete') {
      if (this.meshes.has(id) && !this.meshes.get(id).userData.spec) return; // starter blocks aren't voice creations
      this.deleted.add(id);
      this.removeAssembly(id);
    }
    this.lastScene = -Infinity;
  }

  flushOps(now, send) {
    for (const [id, entry] of this.pending) {
      if (now - entry.sentAt < 500) continue;
      if (!send({ type: 'op', opId: entry.opId, op: entry.op, obj: entry.obj })) continue;
      entry.sentAt = now;
      // Host edits are also in every subsequent scene. Guests wait for authoritative acknowledgement.
      if (this.isHost) this.pending.delete(id);
    }
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
    const present = new Set(msg.objects.map(obj => obj.id));
    for (const id of msg.deleted ?? []) {
      this.deleted.add(id);
      this.pending.delete(id);
      this.removeAssembly(id);
    }
    const acknowledged = new Set(msg.acks ?? []);
    for (const [id, entry] of this.pending) if (acknowledged.has(entry.opId)) this.pending.delete(id);
    for (const [id, root] of this.meshes) {
      if (root.userData.spec && !present.has(id) && this.pending.get(id)?.op !== 'add') this.removeAssembly(id);
    }
    for (const obj of msg.objects) {
      const { id, pos, quat } = obj;
      if (this.pending.get(id)?.op === 'delete' || this.deleted.has(id)) continue;
      if (obj.kind === 'assembly') this.receiveAssembly(obj);
      if (!this.meshes.has(id) || mine.has(id) || this.holders.has(id)) continue;
      if (now - (this.releasedAt.get(id) ?? -Infinity) < SETTLE_MS) continue;
      if (obj.kind === 'assembly') this.meshes.get(id).scale.fromArray(obj.scale);
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
    // Dynamic assemblies use the same ownership stream as starter blocks.
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
      deleted: [...this.deleted],
      acks: [...this.acks],
      objects: [...this.meshes].map(([id, mesh]) => mesh.userData.spec ? this.assemblySnapshot(mesh) : ({
        id, kind: 'box', pos: mesh.position.toArray().map(round), quat: mesh.quaternion.toArray().map(round),
        scale: mesh.scale.toArray(), color: mesh.material.color.getHex(),
      })),
    };
  }
}
