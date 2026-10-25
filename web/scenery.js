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

// Splits every mesh of `root` into square cells of `cell` metres (on x and z), one mesh per material per cell, with the
// world transform baked in. A model exported as one mesh per material has bounds as big as the whole city, so the
// renderer can never skip any of it; as cells, the camera's frustum (and its far plane) drops everything out of view or
// out of fog range before any draw call is made. Call it after fitScenery and before prepareScenery. Returns the cells.
export function chunkScenery(root, cell = 20) {
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse(node => { if (node.isMesh) meshes.push(node); });
  const out = new THREE.Group();
  out.name = 'cells';
  const point = new THREE.Vector3();
  for (const mesh of meshes) {
    const { geometry } = mesh;
    const position = geometry.attributes.position, index = geometry.index;
    const count = (index ? index.count : position.count) / 3;
    const cells = new Map(); // "ix,iz" -> triangle starts in the source index order
    for (let t = 0; t < count; t++) {
      let x = 0, z = 0;
      for (let k = 0; k < 3; k++) {
        point.fromBufferAttribute(position, index ? index.getX(t * 3 + k) : t * 3 + k).applyMatrix4(mesh.matrixWorld);
        x += point.x; z += point.z;
      }
      const key = `${Math.floor(x / 3 / cell)},${Math.floor(z / 3 / cell)}`;
      (cells.get(key) ?? cells.set(key, []).get(key)).push(t);
    }
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (const [key, triangles] of cells) {
      const remap = new Map(), source = [];
      const indices = new Uint32Array(triangles.length * 3);
      triangles.forEach((t, i) => {
        for (let k = 0; k < 3; k++) {
          const old = index ? index.getX(t * 3 + k) : t * 3 + k;
          let id = remap.get(old);
          if (id === undefined) { id = source.length; remap.set(old, id); source.push(old); }
          indices[i * 3 + k] = id;
        }
      });
      const part = new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        const values = new Float32Array(source.length * attribute.itemSize);
        source.forEach((old, i) => {
          for (let c = 0; c < attribute.itemSize; c++) values[i * attribute.itemSize + c] = attribute.getComponent(old, c);
        });
        const copy = new THREE.BufferAttribute(values, attribute.itemSize); // getComponent already denormalised
        if (name === 'position') copy.applyMatrix4(mesh.matrixWorld);
        else if (name === 'normal') copy.applyNormalMatrix(normalMatrix);
        part.setAttribute(name, copy);
      }
      part.setIndex(new THREE.BufferAttribute(source.length > 65535 ? indices : Uint16Array.from(indices), 1));
      part.computeBoundingBox();
      part.computeBoundingSphere();
      const piece = new THREE.Mesh(part, mesh.material);
      piece.name = `${mesh.name || 'mesh'}@${key}`;
      out.add(piece);
    }
    mesh.geometry.dispose();
  }
  // Drop the original meshes (and the nodes that held them) and hang the cells off the root, which keeps the fit.
  for (const mesh of meshes) mesh.removeFromParent();
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  out.applyMatrix4(inverse); // the cells are in world space; the root's own transform applies to them again
  root.add(out);
  root.updateMatrixWorld(true);
  return out.children;
}

// A coarse "is anything here" map of a model, for placing things so they never end up inside it. Each `cell`-metre
// square of the ground has a bit per `layer`-metre slice of height, set when a triangle passes through that slice there.
// Triangles that top out below `groundTop` (the street itself) are ignored. Conservative on purpose: a triangle marks
// every cell of its footprint box, and a cell is filled from the ground up to its highest triangle (a building is a
// hollow shell, and the inside of a shell has no surface of its own), so anything the map calls free really is: the
// price is that the street under an overpass or an arch counts as taken (`low` says which cells those are: where
// the lowest thing is above the ground slice, there is only something overhead). `root`'s matrices must be up to date.
export function buildClearance(root, { cell = 1, layer = 2, layers = 30, groundTop = 0.9, margin = 2 } = {}) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const x0 = box.min.x - margin, z0 = box.min.z - margin;
  const w = Math.ceil((box.max.x - box.min.x + 2 * margin) / cell), d = Math.ceil((box.max.z - box.min.z + 2 * margin) / cell);
  const bits = new Uint32Array(w * d);
  const slice = y => Math.min(layers - 1, Math.max(0, Math.floor(y / layer)));
  const mask = (lo, hi) => (((1 << (hi + 1)) - 1) & ~((1 << lo) - 1)) >>> 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const position = mesh.geometry.attributes.position, index = mesh.geometry.index;
    const count = (index ? index.count : position.count) / 3;
    for (let t = 0; t < count; t++) {
      const at = (k, v) => v.fromBufferAttribute(position, index ? index.getX(t * 3 + k) : t * 3 + k).applyMatrix4(mesh.matrixWorld);
      at(0, a); at(1, b); at(2, c);
      const top = Math.max(a.y, b.y, c.y);
      if (top <= groundTop) continue;
      const bit = mask(slice(Math.min(a.y, b.y, c.y)), slice(top));
      const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - x0) / cell)), ix1 = Math.min(w - 1, Math.floor((Math.max(a.x, b.x, c.x) - x0) / cell));
      const iz0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - z0) / cell)), iz1 = Math.min(d - 1, Math.floor((Math.max(a.z, b.z, c.z) - z0) / cell));
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) bits[iz * w + ix] |= bit;
    }
  });
  const low = new Uint8Array(w * d); // the lowest slice anything reaches in each cell; 0 = it touches the ground, more = it is overhead only
  for (let k = 0; k < bits.length; k++) {
    if (!bits[k]) continue;
    low[k] = 31 - Math.clz32(bits[k] & -bits[k]);
    bits[k] = mask(0, 31 - Math.clz32(bits[k]));
  }
  return {
    x0, z0, w, d, cell, layer, layers, bits, low,
    // True when nothing is within `radius` metres (on the ground plane) of (x, z) between heights y0 and y1.
    clear(x, z, radius, y0, y1) {
      if (y0 >= layers * layer) return true; // above everything the map knows about
      const bit = mask(slice(y0), slice(y1));
      const ix0 = Math.floor((x - radius - x0) / cell), ix1 = Math.floor((x + radius - x0) / cell);
      const iz0 = Math.floor((z - radius - z0) / cell), iz1 = Math.floor((z + radius - z0) / cell);
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          if (ix < 0 || iz < 0 || ix >= w || iz >= d) continue; // off the map is empty
          if (Math.hypot(x0 + (ix + .5) * cell - x, z0 + (iz + .5) * cell - z) > radius + cell * .71) continue;
          if (bits[iz * w + ix] & bit) return false;
        }
      }
      return true;
    },
  };
}

// What the model's own ground is, cell by cell, on the same grid as a `buildClearance` map: 0 none (no ground here, only
// the set's plain floor), 1 road level (below `plazaTop`), 2 plaza level (up to `platformFrom`), 3 raised platform. Only
// flat, upward-facing triangles that top out under `groundTop` count; a cell takes the highest level present. The city's
// streets are the lowest level and its plazas sit 13 cm above them.
export function groundLevels(root, clearance, { groundTop = 0.9, plazaTop = -0.06, platformFrom = 0.2 } = {}) {
  root.updateMatrixWorld(true);
  const { x0, z0, w, d, cell } = clearance;
  const levels = new Uint8Array(w * d);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3(), f = new THREE.Vector3();
  const mark = (ix, iz, level) => { if (ix >= 0 && iz >= 0 && ix < w && iz < d && level > levels[iz * w + ix]) levels[iz * w + ix] = level; };
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const position = mesh.geometry.attributes.position, index = mesh.geometry.index;
    const count = (index ? index.count : position.count) / 3;
    for (let t = 0; t < count; t++) {
      const at = (k, v) => v.fromBufferAttribute(position, index ? index.getX(t * 3 + k) : t * 3 + k).applyMatrix4(mesh.matrixWorld);
      at(0, a); at(1, b); at(2, c);
      if (Math.max(a.y, b.y, c.y) > groundTop) continue;
      n.crossVectors(e.subVectors(b, a), f.subVectors(c, a)).normalize();
      if (n.y < 0.99) continue;
      const y = (a.y + b.y + c.y) / 3;
      const level = y < plazaTop ? 1 : y < platformFrom ? 2 : 3;
      mark(Math.floor(((a.x + b.x + c.x) / 3 - x0) / cell), Math.floor(((a.z + b.z + c.z) / 3 - z0) / cell), level); // tiny triangles still count
      const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - x0) / cell)), ix1 = Math.min(w - 1, Math.floor((Math.max(a.x, b.x, c.x) - x0) / cell));
      const iz0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - z0) / cell)), iz1 = Math.min(d - 1, Math.floor((Math.max(a.z, b.z, c.z) - z0) / cell));
      const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(denominator) < 1e-12) continue;
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const px = x0 + (ix + 0.5) * cell, pz = z0 + (iz + 0.5) * cell; // is the cell's centre inside the triangle (seen from above)?
          const u = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / denominator;
          const v = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / denominator;
          if (u >= 0 && v >= 0 && u + v <= 1) mark(ix, iz, level);
        }
      }
    }
  });
  return levels;
}

// Two materials that look alike (colour to about a sixth, same glow, same transparency) share a key.
export function lookKey(material) {
  const q = v => Math.round(Math.sqrt(Math.max(v, 0)) * 5);
  const { color, emissive } = material;
  return [q(color.r), q(color.g), q(color.b), emissive ? `${q(emissive.r)},${q(emissive.g)},${q(emissive.b)}` : '',
    material.transparent ? Math.round(material.opacity * 10) : '', Math.round((material.metalness ?? 0) * 4), Math.round((material.roughness ?? 1) * 4)].join('|');
}

// Merges every mesh under `root` into one geometry per look (`keyOf(material)`), in root's own frame, keeping only
// positions and normals. A model of hundreds of parts with dozens of near-identical materials becomes a handful of
// draw calls. Returns [{ key, material, geometry, triangles }]; the first material seen for a key is the one used.
export function mergeByLook(root, keyOf = lookKey) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const groups = new Map();
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const key = keyOf(mesh.material);
    if (!groups.has(key)) groups.set(key, { material: mesh.material, meshes: [] });
    groups.get(key).meshes.push(mesh);
  });
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  return [...groups].map(([key, { material, meshes }]) => {
    let vertices = 0, indices = 0;
    for (const mesh of meshes) {
      vertices += mesh.geometry.attributes.position.count;
      indices += mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count;
    }
    const positions = new Float32Array(vertices * 3), normals = new Float32Array(vertices * 3), out = new Uint32Array(indices);
    let v = 0, i = 0;
    for (const mesh of meshes) {
      const source = mesh.geometry.attributes.normal ? mesh.geometry : mesh.geometry.clone();
      if (!source.attributes.normal) source.computeVertexNormals();
      const matrix = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
      const position = source.attributes.position, normal = source.attributes.normal, index = source.index;
      for (let k = 0; k < position.count; k++) {
        p.fromBufferAttribute(position, k).applyMatrix4(matrix).toArray(positions, (v + k) * 3);
        n.fromBufferAttribute(normal, k).applyMatrix3(normalMatrix).normalize().toArray(normals, (v + k) * 3);
      }
      const flip = matrix.determinant() < 0; // a mirrored part turns its triangles inside out; swap two corners back
      const count = index ? index.count : position.count;
      for (let k = 0; k < count; k += 3) {
        const at = j => v + (index ? index.getX(k + j) : k + j);
        out[i++] = at(0); out[i++] = at(flip ? 2 : 1); out[i++] = at(flip ? 1 : 2);
      }
      v += position.count;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(out, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { key, material, geometry, triangles: out.length / 3 };
  });
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
