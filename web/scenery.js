import * as THREE from 'three';

// Scenery is decoration that comes from a model file: placed once, never targeted, grabbed or synced.
// Keep it OUT of the `blocks` container. Interaction raycasts everything inside `blocks` and re-measures it every
// frame, so a detailed city in there would cost frame time for nothing, and every mesh would become grabbable.

// Scales `root`, stands it on y = 0 and centres its footprint on `center` ([x, z]). Returns the final bounds.
// `floor` is the model's own walkable height (before scaling), for a model whose lowest point is not its floor: a
// garden whose rocks hang below its lawn would otherwise be lifted off the ground by the depth of the rocks.
export function fitScenery(root, { scale = 1, center = [0, 0], floor = null } = {}) {
  root.position.set(0, 0, 0);
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const middle = box.getCenter(new THREE.Vector3());
  root.position.set(center[0] - middle.x, floor === null ? -box.min.y : -floor * scale, center[1] - middle.z);
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root);
}

// Marks the model as scenery and freezes its transforms: nothing in it moves, so nothing needs recomputing per frame.
// Shadows are off by default for casting (a night city is lit by its own neon) and on for receiving.
export function prepareScenery(root, { castShadow = false, receiveShadow = true } = {}) {
  root.traverse(node => {
    node.userData.scenery = true;
    if (node.isMesh) {
      node.castShadow = castShadow;
      node.receiveShadow = receiveShadow;
    }
  });
  root.updateMatrixWorld(true);
  root.traverse(node => { node.matrixAutoUpdate = false; });
}

export function sceneryStats(root) {
  const materials = new Set();
  let triangles = 0, meshes = 0;
  root.traverse(node => {
    if (!node.isMesh) return;
    meshes++;
    materials.add(node.material);
    triangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
  });
  return { triangles: Math.round(triangles), meshes, materials: materials.size };
}
