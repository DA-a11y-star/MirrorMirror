import * as THREE from 'three';

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
  if (spec.version !== 1 || !Array.isArray(spec.parts) || !spec.parts.length || spec.parts.length > 40) {
    throw new Error('Invalid object specification');
  }
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
      mesh.quaternion.fromArray(part.quaternion);
      mesh.castShadow = mesh.receiveShadow = true;
      root.add(mesh);
    }
    root.position.fromArray(spec.position);
    root.quaternion.fromArray(spec.quaternion);
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

  add(spec) {
    const root = createAssembly(spec);
    // Try center first, then nearby spots. Keep growth in a small demo workspace.
    const candidates = [[0, 0]];
    for (let ring = 1; ring <= 4; ring++) {
      for (let i = 0; i < 12; i++) {
        const angle = i * Math.PI / 6;
        candidates.push([Math.cos(angle)*ring*.55, Math.sin(angle)*ring*.55]);
      }
    }
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
    this.container.add(root);
    this.interaction.register(root);
    this.history.push(root);
    return root;
  }

  undo() {
    const root = this.history.pop();
    if (!root) return false;
    this.interaction.unregister(root);
    disposeAssembly(root);
    return true;
  }
}
