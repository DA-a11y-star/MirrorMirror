import * as THREE from 'three';
import { MAX_OBJECTS, renderSpec } from './object-protocol.js';

// Unit geometry is shared; each part gets its own material for gaze feedback.
const geometries = new Map();
function geometry(shape) {
  if (!geometries.has(shape)) {
    const factories = {
      box: () => new THREE.BoxGeometry(1, 1, 1),
      sphere: () => new THREE.SphereGeometry(.5, 20, 12),
      cylinder: () => new THREE.CylinderGeometry(.5, .5, 1, 20),
      cone: () => new THREE.ConeGeometry(.5, 1, 20),
    };
    if (!factories[shape]) throw new Error(`Unsupported shape: ${shape}`);
    geometries.set(shape, factories[shape]());
  }
  return geometries.get(shape);
}

export function createAssembly(spec) {
  spec = renderSpec(spec);
  const root = new THREE.Group();
  root.name = spec.name;
  root.userData.id = spec.id;
  root.userData.spec = spec;
  try {
    for (const part of spec.parts) {
      const mesh = new THREE.Mesh(geometry(part.shape), new THREE.MeshStandardMaterial({
        color: part.color, roughness: .65, metalness: 0,
      }));
      mesh.name = part.id;
      mesh.scale.fromArray(part.size);
      mesh.position.fromArray(part.position);
      mesh.quaternion.fromArray(part.quaternion).normalize();
      mesh.castShadow = mesh.receiveShadow = true;
      root.add(mesh);
    }
    root.position.fromArray(spec.position);
    root.quaternion.fromArray(spec.quaternion).normalize();
    return root;
  } catch (error) {
    disposeAssembly(root);
    throw error;
  }
}

export function disposeAssembly(root) {
  root.traverse(node => { if (node.isMesh) node.material.dispose(); });
  root.removeFromParent();
}

export class Objects {
  constructor(container, interaction) {
    this.container = container;
    this.interaction = interaction;
    this.history = [];
  }

  add(spec, { place = true, remember = true, notify = true } = {}) {
    const existing = this.container.children.find(root => root.userData.id === spec.id);
    if (existing) return existing;
    if (this.container.children.length >= MAX_OBJECTS) throw new Error('Workspace is full. Undo an object to make room');
    const root = createAssembly(spec);
    if (place) this.place(root);
    this.container.add(root);
    this.interaction.register(root);
    if (remember) this.history.push(root);
    if (notify) this.onAdd?.(root);
    return root;
  }

  // Try center first, then nearby spots. Keep growth in a small demo workspace.
  _candidates() {
    const candidates = [[0, 0]];
    for (let ring = 1; ring <= 4; ring++) {
      for (let i = 0; i < 12; i++) {
        const angle = i * Math.PI / 6;
        candidates.push([Math.cos(angle)*ring*.55, Math.sin(angle)*ring*.55]);
      }
    }
    return candidates;
  }

  // Where the next object will probably land (assuming a ~0.7 m footprint), for the build animation. Floor level.
  nextSpot(footprint = .7) {
    this.container.updateWorldMatrix(true, true);
    const occupied = this.container.children.map(child => new THREE.Box3().setFromObject(child).expandByScalar(.06));
    const half = footprint / 2;
    for (const [x, z] of this._candidates()) {
      const box = new THREE.Box3(new THREE.Vector3(x - half, 0, z - .4 - half), new THREE.Vector3(x + half, 1, z - .4 + half));
      if (!occupied.some(other => other.intersectsBox(box))) return new THREE.Vector3(x, 0, z - .4);
    }
    return new THREE.Vector3(0, 0, -.4);
  }

  place(root) {
    const candidates = this._candidates();
    this.container.updateWorldMatrix(true, true);
    const occupied = this.container.children.map(child => new THREE.Box3().setFromObject(child).expandByScalar(.06));
    const bounds = new THREE.Box3();
    let placed = false;
    for (const [x, z] of candidates) {
      root.position.set(x, 0, z - .4);
      root.updateWorldMatrix(true, true);
      bounds.setFromObject(root);
      root.position.y -= bounds.min.y;
      root.updateWorldMatrix(true, true);
      bounds.setFromObject(root);
      if (!occupied.some(box => box.intersectsBox(bounds))) { placed = true; break; }
    }
    if (!placed) {
      disposeAssembly(root);
      throw new Error('Workspace is full. Undo an object to make room');
    }
  }

  remove(id, { notify = true } = {}) {
    const root = this.container.children.find(root => root.userData.id === id && root.userData.spec);
    if (!root) return false;
    this.history = this.history.filter(item => item !== root);
    this.interaction.unregister(root);
    disposeAssembly(root);
    if (notify) this.onRemove?.(root);
    return true;
  }

  undo() {
    const root = this.history.at(-1);
    return root ? this.remove(root.userData.id) : false;
  }
}
