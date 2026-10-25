import * as THREE from 'three';
import { buildClearance, groundLevels, lookKey, mergeByLook } from './scenery.js';
import { connectRoads, findJunctions, paintRoads, roadField, roadMesh, roadSkeleton, sampleField, SIDEWALK } from './roads.js';
import { random } from './set-layout.js';

// What a set adds around its city, all decoration except the lamps: painted roads and pavement, cars driving the roads
// and hovering above everything else, floating lights over the junctions, Eve and a Wall-E beside the blocks, movable
// street lamps, and an airship circling the whole area. Each laptop builds its own from the same seed, so they match, and
// nothing here is synced except the lamps, which are ordinary shared objects (see `lampSpec`). The planning functions are pure.

export const CAR_COLORS = [0xff4fd8, 0x38e8ff, 0xffb347, 0x8a5cff, 0x7dff6a, 0xff3b3b, 0xe8ecff, 0xffe14d];
export const SURFACE = 0.02; // the painted road is this high: where wheels and feet rest

// The model's body panels are the strongly red, unlit materials; the glass, tyres and lights are not.
export function isCarBody(material) {
  const { color, emissive } = material;
  return color.r > 0.3 && color.g < 0.08 && color.b < 0.1 && (!emissive || emissive.r + emissive.g + emissive.b < 0.01);
}

const yawFor = (hx, hz) => Math.atan2(-hz, hx); // a model that points +x, turned to face (hx, hz)

// Cars on the roads, in lanes. A candidate is a point on a road's middle line (`skeleton`, see roads.js); a wide road gets a
// lane each way (driving on the right: the right of heading h is (-h.z, h.x)), a narrow one a single lane down the middle.
// The candidates are shuffled and a car is kept when it sits wholly on asphalt (also at its nose and tail, so a bend
// is fine), is inside `visible` (optional: everywhere by default), outside every `avoid`
// disc, clear of every other car by a car length, and `gap` metres (picked between its two numbers) behind or ahead of
// any car already going its way. -> [{x, y, z, yaw, air: false, color}]
export function planRoadCars({ skeleton, field, rand, car, gap = [9, 17], max = 24, avoid = [], visible = () => true, twoLanes = 2.5 }) {
  const candidates = skeleton.filter(p => p.line >= 0.6);
  for (let i = candidates.length - 1; i > 0; i--) { // seeded shuffle
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const plan = [], headings = [];
  const onRoad = (x, z, need) => sampleField(field, field.road, x, z) >= need;
  for (const p of candidates) {
    if (plan.length >= max) break;
    const wide = p.half >= twoLanes;
    const dirs = wide ? (rand() < 0.5 ? [1, -1] : [-1, 1]) : [rand() < 0.5 ? 1 : -1];
    for (const dir of dirs) {
      const hx = p.tx * dir, hz = p.tz * dir;
      const offset = wide ? p.half / 2 : 0;
      const x = p.x - hz * offset, z = p.z + hx * offset;
      if (!onRoad(x, z, car.width / 2 + 0.1)) continue;
      if (!onRoad(x + hx * car.length * 0.4, z + hz * car.length * 0.4, car.width / 2 - 0.15)) continue;
      if (!onRoad(x - hx * car.length * 0.4, z - hz * car.length * 0.4, car.width / 2 - 0.15)) continue;
      if (avoid.some(a => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
      if (!visible(x, SURFACE + car.height / 2, z, car.radius)) continue;
      const wanted = gap[0] + rand() * (gap[1] - gap[0]);
      const crowded = plan.some((other, i) => {
        const between = Math.hypot(other.x - x, other.z - z);
        return between < car.length + 1.5 || (between < wanted && headings[i][0] * hx + headings[i][1] * hz > 0.5);
      });
      if (crowded) continue;
      plan.push({ x, y: SURFACE, z, yaw: yawFor(hx, hz), air: false, color: CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)] });
      headings.push([hx, hz]);
      break;
    }
  }
  return plan;
}

// Cars hovering above everything: a jittered grid, one car per `spacing` metres at most, shuffled so `max` are spread over
// the area, each at one of `altitudes` (the height of its wheels). A car is kept only inside `visible` (optional), outside the
// `avoid` discs, at least 0.7 x spacing from the others, and when `clearance` says nothing of the model is within its
// footprint at its height, so none is ever inside a building. It faces along the axis with more room.
// -> [{x, y, z, yaw, air: true, color}]
export function planAirCars({ clearance, rand, bounds, spacing = 15, max = 20, altitudes = [6], car, avoid = [], visible = () => true }) {
  const cells = [];
  for (let x = bounds.minX + spacing / 2; x < bounds.maxX; x += spacing) {
    for (let z = bounds.minZ + spacing / 2; z < bounds.maxZ; z += spacing) cells.push([x, z]);
  }
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  const plan = [];
  const run = (x, z, dx, dz, y0, y1) => { // metres of room from (x, z) along one direction, up to 24
    let n = 0;
    while (n < 24 && clearance.clear(x + dx * (n + 1), z + dz * (n + 1), car.width / 2 + 0.3, y0, y1)) n++;
    return n;
  };
  for (const [cx, cz] of cells) {
    for (let attempt = 0; attempt < 6 && plan.length < max; attempt++) {
      const x = cx + (rand() - 0.5) * spacing, z = cz + (rand() - 0.5) * spacing;
      const y = altitudes[Math.floor(rand() * altitudes.length)];
      if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
      if (avoid.some(a => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
      if (plan.some(p => Math.hypot(p.x - x, p.z - z) < spacing * 0.7)) continue;
      if (!visible(x, y + car.height / 2, z, car.radius)) continue;
      const y0 = Math.max(0, y - 0.4), y1 = y + car.height + 0.4;
      if (!clearance.clear(x, z, car.radius, y0, y1)) continue;
      const alongX = run(x, z, 1, 0, y0, y1) + run(x, z, -1, 0, y0, y1), alongZ = run(x, z, 0, 1, y0, y1) + run(x, z, 0, -1, y0, y1);
      const yaw = (alongX >= alongZ ? 0 : Math.PI / 2) + (rand() < 0.5 ? Math.PI : 0);
      plan.push({ x, y, z, yaw, air: true, color: CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)] });
      break;
    }
    if (plan.length >= max) break;
  }
  return plan;
}

// Where the street lamps stand: on the pavement just beside the asphalt (0.65 m past its edge), on whichever side has
// room, about `gap` metres apart (randomly 1 to 1.4 times that), only within `radius` of `around` and nearest first, at
// most `max`, and never inside an `avoid` disc. The same input gives the same lamps on every laptop, so each lamp can have a stable id.
// -> [{x, z, yaw, color}]; yaw turns a model whose arm points +x to point at the road.
export const LAMP_COLORS = ['#ff7ad9', '#5fe9ff', '#ffc46b'];
export function planLamps({ skeleton, field, clearance, rand, around, radius = 55, gap = 17, max = 20, avoid = [] }) {
  const candidates = skeleton.filter(p => p.line >= 0.6 && Math.hypot(p.x - around.x, p.z - around.z) <= radius);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const { x0, z0, w, d, cell } = field;
  const lamps = [];
  for (const p of candidates) {
    const wanted = gap * (1 + rand() * 0.4);
    if (lamps.some(l => Math.hypot(l.x - p.x, l.z - p.z) < wanted)) continue;
    const nx = -p.tz, nz = p.tx;
    for (const side of rand() < 0.5 ? [1, -1] : [-1, 1]) {
      const x = p.x + nx * side * (p.half + 0.65), z = p.z + nz * side * (p.half + 0.65);
      const ix = Math.floor((x - x0) / cell), iz = Math.floor((z - z0) / cell);
      if (ix < 0 || iz < 0 || ix >= w || iz >= d) continue;
      const level = field.levels[iz * w + ix];
      if ((level !== 1 && level !== 2) || field.blocked[iz * w + ix] || field.road[iz * w + ix] > 0) continue; // pavement only
      if (avoid.some(a => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
      if (sampleField(field, field.dist, x, z) < 0.5 || !clearance.clear(x, z, 0.45, 0.3, 4)) continue;
      lamps.push({ x, z, yaw: yawFor(-nx * side, -nz * side), color: LAMP_COLORS[Math.floor(rand() * LAMP_COLORS.length)] });
      break;
    }
  }
  return lamps.sort((a, b) => Math.hypot(a.x - around.x, a.z - around.z) - Math.hypot(b.x - around.x, b.z - around.z)).slice(0, max);
}

// A street lamp as a shared, grabbable assembly (the same format voice objects use): a base, a 9 m pole, an arm over the
// road and a glowing lamp head, 9.8 m tall in all. The assembly's position is relative to `origin` ([x, z]: where the blocks'
// group sits, since every shared object lives inside it), and its base is on the road, so it stands where it was planned
// and can be carried anywhere.
export function lampSpec(lamp, index, origin = [0, 0]) {
  const s = Math.sin(lamp.yaw / 2), c = Math.cos(lamp.yaw / 2);
  const part = (id, shape, size, position, color, emissive) => ({
    id, shape, size, position, quaternion: [0, 0, 0, 1], color, ...(emissive ? { emissive } : {}),
  });
  return {
    version: 1, id: `lamp-${index}`, name: 'street lamp', position: [lamp.x - origin[0], SURFACE, lamp.z - origin[1]], quaternion: [0, s, 0, c],
    parts: [
      part('base', 'cylinder', [0.8, 0.5, 0.8], [0, 0.25, 0], '#2b2740'),
      part('pole', 'cylinder', [0.32, 9, 0.32], [0, 5, 0], '#3a3552'),
      part('arm', 'box', [2.6, 0.28, 0.28], [1.2, 9.6, 0], '#3a3552'),
      part('lamp', 'box', [1.1, 0.2, 0.7], [2.2, 9.42, 0], lamp.color, lamp.color),
    ],
  };
}

// Where the airship is: a level circle of `radius` around `center` ([x, z]) at `height`, one lap per `period` seconds.
// `state` ({theta}) is advanced in place. -> {position, yaw} (yaw for a model whose nose points +x, so it flies forward).
export function airshipAt(state, dt, { center, radius, height, period, start = 0 }) {
  state.theta = ((state.theta ?? start) + dt * Math.PI * 2 / period) % (Math.PI * 2);
  const position = new THREE.Vector3(center[0] + Math.cos(state.theta) * radius, height, center[1] + Math.sin(state.theta) * radius);
  return { position, yaw: yawFor(-Math.sin(state.theta), Math.cos(state.theta)) };
}

// Wall-E from primitives, `height` metres tall, standing on y = 0 and facing +z.
export function buildWallE(height = 1.05) {
  const root = new THREE.Group();
  root.name = 'wall-e';
  const paint = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.2, ...extra });
  const rust = paint(0xd79a1c), dark = paint(0x2c2b29, { roughness: 0.9 }), grey = paint(0x6b6a66), housing = paint(0xa89a6a);
  const lens = paint(0x0e1318, { roughness: 0.2 }), glow = paint(0x66ccff, { emissive: 0x66ccff, emissiveIntensity: 1.6 });
  const add = (geometry, material, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    root.add(mesh);
    return mesh;
  };
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(0.2, 0.22, 0.56), dark, side * 0.3, 0.12, 0); // track
    for (const end of [-1, 1]) add(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 14), dark, side * 0.3, 0.12, end * 0.28, 0, 0, Math.PI / 2);
    add(new THREE.BoxGeometry(0.05, 0.3, 0.06), grey, side * 0.35, 0.42, 0.14, -0.35); // arm
    add(new THREE.BoxGeometry(0.07, 0.07, 0.08), grey, side * 0.35, 0.28, 0.22); // hand
    add(new THREE.CylinderGeometry(0.09, 0.09, 0.15, 16), housing, side * 0.13, 0.98, 0.05, Math.PI / 2); // eye housing
    add(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 16), lens, side * 0.13, 0.98, 0.135, Math.PI / 2); // lens
    add(new THREE.SphereGeometry(0.03, 10, 8), glow, side * 0.13, 0.98, 0.145); // glint
  }
  add(new THREE.BoxGeometry(0.56, 0.42, 0.52), rust, 0, 0.43, 0); // body
  add(new THREE.BoxGeometry(0.36, 0.2, 0.03), paint(0x8a6a1d), 0, 0.42, 0.275); // chest hatch
  add(new THREE.BoxGeometry(0.4, 0.04, 0.4), grey, 0, 0.66, 0); // shoulder plate
  add(new THREE.CylinderGeometry(0.04, 0.04, 0.26, 10), grey, 0, 0.8, 0); // neck
  add(new THREE.BoxGeometry(0.36, 0.05, 0.12), housing, 0, 1.06, 0.03); // brow
  root.scale.setScalar(height / 1.09);
  return root;
}

// Eve (or any model) scaled to `height` metres, centred on x and z, with its feet on y = 0 and its eyes lit.
export function fitFigure(model, height) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  const k = height / size.y;
  model.scale.setScalar(k);
  model.position.set(-centre.x * k, -box.min.y * k, -centre.z * k);
  const holder = new THREE.Group();
  holder.add(model);
  model.traverse(node => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.material = node.material.clone();
    if (/eye/i.test(node.material.name)) {
      node.material.emissive = node.material.color.clone();
      node.material.emissiveIntensity = 1.8;
    }
  });
  return holder;
}

// The car model as one geometry per look, scaled to `length` metres, nose toward +x, wheels on y = 0. The red body panels
// are one white-tinted part so each car can be given its own colour. The nose is where the (blue-white) headlights are
// relative to the (red) tail lights.
export function carParts(root, length) {
  root.updateMatrixWorld(true);
  const lights = { head: [], tail: [] };
  root.traverse(node => {
    if (!node.isMesh || !node.material.emissive) return;
    const { emissive } = node.material;
    if (emissive.r + emissive.g + emissive.b < 0.05) return;
    lights[emissive.b > emissive.r ? 'head' : 'tail'].push(new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3()));
  });
  const mean = list => list.reduce((sum, v) => sum.add(v), new THREE.Vector3()).divideScalar(Math.max(1, list.length));
  const nose = lights.head.length && lights.tail.length ? mean(lights.head).sub(mean(lights.tail)) : new THREE.Vector3(1, 0, 0);

  const parts = mergeByLook(root, material => (isCarBody(material) ? 'body' : lookKey(material)));
  const box = new THREE.Box3();
  for (const part of parts) box.union(part.geometry.boundingBox);
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  const turn = new THREE.Matrix4().makeRotationY(size.z > size.x ? Math.PI / 2 : 0);
  if (nose.clone().applyMatrix4(turn).x < 0) turn.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
  const k = length / Math.max(size.x, size.z);
  const fit = new THREE.Matrix4().multiply(turn).multiply(new THREE.Matrix4().makeScale(k, k, k))
    .multiply(new THREE.Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z));
  const bounds = new THREE.Box3();
  for (const part of parts) {
    part.geometry.applyMatrix4(fit);
    part.geometry.computeBoundingBox();
    part.geometry.computeBoundingSphere();
    bounds.union(part.geometry.boundingBox);
    if (part.key === 'body') {
      part.material = part.material.clone();
      part.material.color.set(0xffffff);
      part.material.roughness = 0.45;
    }
  }
  const dims = bounds.getSize(new THREE.Vector3());
  return { parts, length: dims.x, width: dims.z, height: dims.y, radius: Math.max(dims.x, dims.z) / 2 + 0.3 };
}

// The cars of `plan` as instanced meshes: one per look per `chunk`-metre square of the city, so the camera drops the
// squares it can't see (and those past the far plane) whole, and the whole city's cars cost only what is near. Hovering
// cars bob a little. `meshes` lists them all, `chunks` each square's cars and meshes.
export class Cars {
  constructor({ parts }, plan, { chunk = 50 } = {}) {
    this.plan = plan;
    this.group = new THREE.Group();
    this.group.name = 'cars';
    this.chunks = [];
    this.meshes = [];
    const squares = new Map();
    plan.forEach((car, i) => {
      const key = `${Math.floor(car.x / chunk)},${Math.floor(car.z / chunk)}`;
      (squares.get(key) ?? squares.set(key, []).get(key)).push({ car, phase: i * 1.7 });
    });
    for (const entries of squares.values()) {
      const meshes = parts.map(part => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, entries.length);
        mesh.castShadow = mesh.receiveShadow = false;
        mesh.userData.scenery = true;
        this.group.add(mesh);
        if (part.key === 'body') entries.forEach((entry, k) => mesh.setColorAt(k, new THREE.Color(entry.car.color)));
        return mesh;
      });
      this.chunks.push({ entries, meshes, air: entries.some(entry => entry.car.air) });
      this.meshes.push(...meshes);
    }
    this.update(0);
    for (const mesh of this.meshes) {
      mesh.computeBoundingSphere();
      mesh.boundingSphere.radius += 2; // room for the bobbing
    }
  }

  update(seconds) {
    const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const position = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    for (const chunk of this.chunks) {
      if (this._placed && !chunk.air) continue; // parked and driving cars never move
      chunk.entries.forEach(({ car, phase }, k) => {
        if (!car.air && this._placed) return;
        euler.set(car.air ? Math.sin(seconds * 0.5 + phase) * 0.03 : 0, car.yaw, car.air ? Math.sin(seconds * 0.4 + phase) * 0.03 : 0);
        position.set(car.x, car.y + (car.air ? Math.sin(seconds * 0.8 + phase) * 0.3 : 0), car.z);
        matrix.compose(position, quaternion.setFromEuler(euler), one);
        for (const mesh of chunk.meshes) mesh.setMatrixAt(k, matrix);
      });
      if (chunk.air) for (const mesh of chunk.meshes) mesh.instanceMatrix.needsUpdate = true;
    }
    this._placed = true;
  }
}

// Lights floating over the road junctions: a dark disc, a glowing underside and a faint cone of light down to the road,
// in a rotating choice of neon colours. Three instanced meshes in all, however many junctions; the discs bob a little.
export const LIGHT_COLORS = [0xff7ad9, 0x5fe9ff, 0xffc46b];
export class JunctionLights {
  constructor(junctions, { height = 7.5 } = {}) {
    this.junctions = junctions;
    this.height = height;
    this.group = new THREE.Group();
    this.group.name = 'junction-lights';
    const n = Math.max(1, junctions.length);
    const body = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.9, 1.05, 0.3, 20), new THREE.MeshStandardMaterial({ color: 0x2b2740, roughness: 0.5, metalness: 0.6 }), n);
    const glow = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.78, 0.78, 0.06, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), n);
    const cone = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.78, 3.6, height, 24, 1, true), new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }), n);
    this.meshes = [body, glow, cone];
    for (const mesh of this.meshes) { mesh.count = junctions.length; mesh.userData.scenery = true; mesh.castShadow = mesh.receiveShadow = false; this.group.add(mesh); }
    const matrix = new THREE.Matrix4();
    junctions.forEach((j, i) => {
      const color = new THREE.Color(LIGHT_COLORS[i % LIGHT_COLORS.length]);
      glow.setColorAt(i, color);
      cone.setColorAt(i, color);
      cone.setMatrixAt(i, matrix.makeTranslation(j.x, SURFACE + height / 2, j.z)); // from the light (small end, up) to the road
    });
    this.update(0);
    for (const mesh of this.meshes) { mesh.computeBoundingSphere(); mesh.boundingSphere.radius += 1; }
  }

  update(seconds) {
    const matrix = new THREE.Matrix4();
    this.junctions.forEach((j, i) => {
      const y = SURFACE + this.height + Math.sin(seconds * 0.9 + i * 2.1) * 0.15;
      this.meshes[0].setMatrixAt(i, matrix.makeTranslation(j.x, y, j.z));
      this.meshes[1].setMatrixAt(i, matrix.makeTranslation(j.x, y - 0.18, j.z));
    });
    this.meshes[0].instanceMatrix.needsUpdate = this.meshes[1].instanceMatrix.needsUpdate = true;
  }
}

// The airship model as a few merged meshes (it has hundreds of parts), scaled to `length` metres along x, centred.
export function airshipMesh(root, length) {
  const parts = mergeByLook(root);
  const box = new THREE.Box3();
  for (const part of parts) box.union(part.geometry.boundingBox);
  const centre = box.getCenter(new THREE.Vector3());
  const k = length / box.getSize(new THREE.Vector3()).x;
  const group = new THREE.Group();
  group.name = 'airship';
  let triangles = 0;
  for (const part of parts) {
    part.geometry.translate(-centre.x, -centre.y, -centre.z);
    part.geometry.scale(k, k, k);
    part.geometry.computeBoundingSphere();
    const material = part.material.clone();
    material.fog = false; // it floats past the fog's start but must stay readable
    const mesh = new THREE.Mesh(part.geometry, material);
    mesh.userData.scenery = true;
    group.add(mesh);
    triangles += part.triangles;
  }
  group.userData.triangles = triangles;
  return group;
}

// Builds a set's extras in and around its city. `city` is the loaded scenery root and `addLamp(spec)` adds a shared lamp.
// Everything is planned from `rand` (a seeded generator) and the model alone, so every laptop builds the same cars, lamps
// and lights. Resolves with {group, stats, layout, world, update(dt, seconds)}; a part that fails is logged and skipped.
export async function loadSetProps(set, { scene, loader, city, addLamp, rand = random(1) }) {
  const spec = set.props;
  if (!spec) return null;
  const group = new THREE.Group();
  group.name = 'props';
  scene.add(group);
  const updates = [], stats = {}, layout = {};
  const [wx, wz] = set.workspace ?? [0, 0];
  const attempt = async (name, build) => {
    try { await build(); } catch (error) { console.error(`[props] ${name}: ${error.message}`); }
  };

  let world = null; // the city as a map: where roads, pavement and buildings are
  await attempt('roads', async () => {
    const sidewalk = spec.roads?.sidewalk ?? SIDEWALK;
    const clearance = buildClearance(city, { cell: 0.25, margin: 8 }); // a margin all round, for roads that go round the outside
    const ground = groundLevels(city, clearance);
    // Pieces of road that stop at a gap are joined first, and the field is rebuilt with the new roads in it.
    const joined = connectRoads(roadField(clearance, ground, { sidewalk }), { sidewalk, ...spec.roads?.join });
    const field = roadField(clearance, joined.levels, { sidewalk });
    const skeleton = roadSkeleton(field);
    group.add(roadMesh(paintRoads(field, skeleton)));
    world = { clearance, field, skeleton };
    stats.roadLength = Math.round(skeleton.length * field.cell);
    stats.roadLinks = joined.bridges.length;
  });

  if (spec.junctions && world) {
    await attempt('junction lights', async () => {
      const { height = 7.5 } = spec.junctions;
      const where = findJunctions(world.skeleton).filter(j => world.clearance.clear(j.x, j.z, 1.2, height - 1, height + 1));
      const lights = new JunctionLights(where, spec.junctions);
      group.add(lights.group);
      updates.push((dt, seconds) => lights.update(seconds));
      layout.junctions = where;
      stats.junctionLights = where.length;
    });
  }

  if (spec.cars && world) {
    await attempt('cars', async () => {
      const gltf = await loader.loadAsync(spec.cars.model);
      const car = carParts(gltf.scene, spec.cars.length);
      const box = new THREE.Box3().setFromObject(city);
      const common = { rand, car, avoid: [{ x: wx, z: wz, r: spec.cars.avoid ?? 10 }] };
      const onRoad = planRoadCars({ ...common, skeleton: world.skeleton, field: world.field, ...spec.cars.road });
      // Hovering traffic belongs over the built-up part: within 25 m of a building, not out over empty ground.
      const builtUp = (x, y, z) => sampleField(world.field, world.field.dist, x, z) < 25;
      const inAir = planAirCars({
        ...common, visible: builtUp, clearance: world.clearance, ...spec.cars.air,
        bounds: { minX: box.min.x + 3, maxX: box.max.x - 3, minZ: box.min.z + 3, maxZ: box.max.z - 3 },
      });
      const cars = new Cars(car, [...onRoad, ...inAir], { chunk: spec.cars.chunk });
      group.add(cars.group);
      updates.push((dt, seconds) => cars.update(seconds));
      layout.cars = cars.plan;
      stats.carsOnRoad = onRoad.length;
      stats.carsInAir = inAir.length;
      stats.carChunks = cars.chunks.length;
      stats.carMeshes = cars.meshes.length;
    });
  }

  if (spec.lamps && world && addLamp) {
    await attempt('lamps', async () => {
      const lamps = planLamps({ ...world, rand: random(1), around: { x: wx, z: wz }, avoid: [{ x: wx, z: wz, r: 5 }], ...spec.lamps });
      lamps.forEach((lamp, i) => addLamp(lampSpec(lamp, i, [wx, wz])));
      layout.lamps = lamps;
      stats.lamps = lamps.length;
    });
  }

  const faceBlocks = Math.PI / 2; // the figures stand west of the blocks and face them (+x)
  if (spec.eve) {
    await attempt('eve', async () => {
      const gltf = await loader.loadAsync(spec.eve.model);
      const eve = fitFigure(gltf.scene, spec.eve.height);
      eve.position.set(wx + spec.eve.offset[0], SURFACE + spec.eve.hover, wz + spec.eve.offset[1]);
      eve.rotation.y = faceBlocks;
      group.add(eve);
      updates.push((dt, seconds) => { eve.position.y = SURFACE + spec.eve.hover + Math.sin(seconds * 1.1) * 0.06; });
      stats.eve = true;
    });
  }
  if (spec.walle) {
    const walle = buildWallE(spec.walle.height);
    walle.position.set(wx + spec.walle.offset[0], SURFACE, wz + spec.walle.offset[1]);
    walle.rotation.y = faceBlocks;
    group.add(walle);
    stats.walle = true;
  }

  if (spec.airship) {
    await attempt('airship', async () => {
      const gltf = await loader.loadAsync(spec.airship.model);
      const ship = airshipMesh(gltf.scene, spec.airship.length);
      group.add(ship);
      const state = {};
      const orbit = { center: [wx, wz], start: rand() * Math.PI * 2, ...spec.airship };
      const place = dt => {
        const pose = airshipAt(state, dt, orbit);
        ship.position.copy(pose.position);
        ship.rotation.set(0.07, pose.yaw + (spec.airship.yawOffset ?? 0), 0, 'YXZ'); // a slight bank into the turn
      };
      place(0);
      updates.push(dt => place(dt));
      stats.airshipTriangles = ship.userData.triangles;
    });
  }
  group.traverse(node => { node.userData.scenery = true; });
  return { group, stats, layout, world, update: (dt, seconds) => updates.forEach(fn => fn(dt, seconds)) };
}
