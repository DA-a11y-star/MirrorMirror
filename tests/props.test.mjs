import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';

const three = new URL('../web/vendor/three.module.js', import.meta.url).href;
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function load(name, imports = {}) {
  let source = (await readFile(new URL(`../web/${name}.js`, import.meta.url), 'utf8')).replaceAll("from 'three'", `from '${three}'`);
  for (const [path, url] of Object.entries(imports)) source = source.replaceAll(`from './${path}.js'`, `from '${url}'`);
  return { module: await import(dataUrl(source)), url: dataUrl(source) };
}
const scenery = await load('scenery');
const layout = await load('set-layout');
const roads = await load('roads');
const protocol = await load('object-protocol');
const objects = await load('objects', { 'object-protocol': protocol.url });
const sync = await load('sync', { 'object-protocol': protocol.url });
const ambience = await load('ambience', { roads: roads.url, 'set-layout': layout.url });
const props = (await load('props', { scenery: scenery.url, roads: roads.url, ambience: ambience.url, 'set-layout': layout.url })).module;
const { buildClearance, groundLevels, mergeByLook } = scenery.module;
const { roadField, roadSkeleton, paintRoads, sampleField, connectRoads, findJunctions, ROAD_COLORS } = roads.module;
const { random } = layout.module;
const { separatePatrols, planRoadCars, planAirCars, planLamps, lampSpec, airshipAt, buildWallE, carParts, Cars, JunctionLights, isCarBody, CAR_COLORS, SURFACE } = props;

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, ...extra });
const box = (w, h, d, x, y, z, material = mat(0x888888)) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
};
const plane = (w, d, x, y, z) => { // flat ground facing up
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0x444444));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
};
// A road 12 m wide along x between two buildings, a plaza (higher ground) beside the road's west end, a building on it,
// and a lamp post (too small to be a building) in the road. Road-level ground is 13 cm below the plaza, as in the real city.
function city() {
  const root = new THREE.Group();
  root.add(box(80, 20, 20, 0, 10, 16), box(80, 20, 20, 0, 10, -16)); // buildings at |z| from 6 to 26
  root.add(plane(80, 12, 0, -0.134, 0)); // road-level ground
  root.add(plane(30, 12, -55, 0, 0), box(10, 8, 10, -55, 4, 0)); // plaza ground and a building on it
  root.add(box(0.3, 5, 0.3, 10, 2.5, 0)); // a lamp post standing in the road
  root.add(box(8, 1, 12, 22, 6.5, 0)); // an overpass across the road: a deck 6 m up, nothing at ground level
  root.updateMatrixWorld(true);
  return root;
}
function world() {
  const root = city();
  const clearance = buildClearance(root, { cell: 0.25 });
  const levels = groundLevels(root, clearance);
  const field = roadField(clearance, levels);
  return { root, clearance, levels, field, skeleton: roadSkeleton(field) };
}
const w = world();

test('groundLevels tells road-level ground, plaza ground and no ground apart', () => {
  const cell = (x, z) => w.levels[Math.floor((z - w.clearance.z0) / 0.25) * w.clearance.w + Math.floor((x - w.clearance.x0) / 0.25)];
  assert.equal(cell(0, 0), 1, 'road');
  assert.equal(cell(-45, 4), 2, 'plaza');
  assert.equal(cell(0, 20), 0, 'inside a building there is no ground');
  assert.equal(cell(0, 27), 0, 'off the ground');
});

test('buildClearance.low tells overhead-only cells (an overpass) from solid ones (a building)', () => {
  const lowAt = (x, z) => w.clearance.low[Math.floor((z - w.clearance.z0) / 0.25) * w.clearance.w + Math.floor((x - w.clearance.x0) / 0.25)];
  assert.equal(lowAt(0, 6.1), 0, 'a building wall touches the ground');
  assert.ok(lowAt(22, 0) >= 2, `the overpass deck starts above the ground: ${lowAt(22, 0)}`);
});

test('roadField: the road runs on under an overpass, and keeps its asphalt where it is narrow', () => {
  const at = (x, z) => Math.floor((z - w.field.z0) / 0.25) * w.field.w + Math.floor((x - w.field.x0) / 0.25);
  assert.equal(w.field.blocked[at(22, 0)], 0, 'not solid under the deck');
  assert.ok(w.field.road[at(22, 0)] > 4, 'asphalt under the deck');
  assert.equal(w.field.blocked[at(0, 16)], 1, 'a building is still solid');
  // A road only 3 m wide between buildings: a fixed 1.2 m strip each side would leave 0.6 m; the strip shrinks with the road.
  const narrow = new THREE.Group();
  narrow.add(box(80, 20, 20, 0, 10, 11.5), box(80, 20, 20, 0, 10, -11.5), plane(80, 3, 0, -0.134, 0));
  narrow.updateMatrixWorld(true);
  const clearance = buildClearance(narrow, { cell: 0.25 });
  const field = roadField(clearance, groundLevels(narrow, clearance));
  const centre = Math.floor((0 - field.z0) / 0.25) * field.w + Math.floor((0 - field.x0) / 0.25);
  assert.ok(field.walk[centre] < 0.6 && field.road[centre] > 0.8, `strip ${field.walk[centre].toFixed(2)} m, asphalt half-width ${field.road[centre].toFixed(2)} m`);
  assert.ok(w.field.walk[at(0, 0)] > 1.1, 'a wide road keeps the full strip');
});

const components = field => { // the pieces of asphalt, as lists of cells
  const label = new Int32Array(field.w * field.d).fill(-1), pieces = [];
  for (let start = 0; start < label.length; start++) {
    if (field.road[start] <= 0.5 || label[start] >= 0) continue;
    const stack = [start], cells = [];
    label[start] = pieces.length;
    while (stack.length) {
      const at = stack.pop(), x = at % field.w, z = (at - x) / field.w;
      cells.push(at);
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        if (nx < 0 || nz < 0 || nx >= field.w || nz >= field.d) continue;
        const next = nz * field.w + nx;
        if (field.road[next] > 0.5 && label[next] < 0) { label[next] = pieces.length; stack.push(next); }
      }
    }
    pieces.push(cells);
  }
  return pieces;
};
function gapCity(wall) { // two roads in a line with a gap between them, and a building (or a long wall) in the gap
  const root = new THREE.Group();
  root.add(plane(28, 6, -26, -0.134, 0), plane(28, 6, 26, -0.134, 0));
  root.add(plane(1, 1, 0, -0.134, -30), plane(1, 1, 0, -0.134, 30)); // specks of ground that widen the map, so there is room to go round
  root.add(wall ? box(4, 20, 120, 0, 10, 0) : box(16, 20, 20, 0, 10, 0));
  root.updateMatrixWorld(true);
  const clearance = buildClearance(root, { cell: 0.25 });
  return { clearance, field: roadField(clearance, groundLevels(root, clearance)) };
}

test('connectRoads joins roads that stop at a gap, going around a building, and leaves them alone behind a wall', () => {
  const open = gapCity(false);
  assert.equal(components(open.field).length, 2, 'two separate roads to start with');
  const joined = connectRoads(open.field);
  assert.equal(joined.bridges.length, 1);
  assert.ok(joined.bridges[0].points.length >= 3, 'it bends round the building');
  assert.ok(joined.bridges[0].points.every(([x, z]) => !(Math.abs(x) < 10 && Math.abs(z) < 12)), 'and keeps clear of it');
  const after = roadField(open.clearance, joined.levels);
  assert.equal(components(after).length, 1, 'one road network afterwards');
  assert.equal(joined.levels[Math.floor((0 - open.field.z0) / 0.25) * open.field.w + Math.floor((0 - open.field.x0) / 0.25)], open.field.levels[Math.floor((0 - open.field.z0) / 0.25) * open.field.w + Math.floor((0 - open.field.x0) / 0.25)], 'the building itself is untouched');
  const walled = gapCity(true);
  assert.equal(connectRoads(walled.field).bridges.length, 0, 'no way round a wall across everything');
  assert.equal(connectRoads(open.field, { maxBridge: 20 }).bridges.length, 0, 'too far to bother');
});

test('findJunctions finds a crossing and ignores a straight road', () => {
  const root = new THREE.Group();
  root.add(plane(80, 6, 0, -0.134, 0), plane(6, 80, 0, -0.134, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) root.add(box(32, 20, 32, sx * 19.5, 10, sz * 19.5)); // four blocks around a crossing
  root.updateMatrixWorld(true);
  const clearance = buildClearance(root, { cell: 0.25 });
  const field = roadField(clearance, groundLevels(root, clearance));
  const found = findJunctions(roadSkeleton(field));
  assert.equal(found.length, 1, `one crossing: ${JSON.stringify(found)}`);
  assert.ok(Math.hypot(found[0].x, found[0].z) < 2 && found[0].arms >= 3);
  assert.equal(findJunctions(w.skeleton).filter(j => j.x > -35).length, 0, 'a straight road has none');
});

test('roadField: a pavement strip beside the buildings, asphalt beyond it, a lamp post is not a building', () => {
  const dist = (x, z) => sampleField(w.field, w.field.dist, x, z), road = (x, z) => sampleField(w.field, w.field.road, x, z);
  assert.ok(Math.abs(dist(0, 5.4) - 0.6) < 0.3, `0.6 m from the building: ${dist(0, 5.4)}`);
  assert.ok(road(0, 5.4) === 0 && road(0, 0) > 4, 'the strip is not asphalt, the middle is');
  assert.ok(Math.abs(road(0, 0) - 4.8) < 0.4, `the asphalt is 12 - 2 x 1.2 wide: half ${road(0, 0)}`);
  assert.ok(road(10, 0) > 4, 'the lamp post does not cut the road');
  assert.equal(w.field.blocked[Math.floor((0 - w.field.z0) / 0.25) * w.field.w + Math.floor((10 - w.field.x0) / 0.25)], 0);
});

test('roadSkeleton follows the middle of the road, with its direction', () => {
  const middle = w.skeleton.filter(p => Math.abs(p.z) < 1 && p.x > -35 && p.x < 35);
  assert.ok(middle.length > 80, `${middle.length} middle-line points`);
  for (const p of middle.filter(p => p.line > 0.9)) {
    assert.ok(Math.abs(p.tx) > 0.98 && p.tx > 0, `runs along x, sign fixed (${p.tx}, ${p.tz})`);
    assert.ok(Math.abs(p.half - 4.8) < 0.5);
  }
  assert.ok(middle.filter(p => p.line > 0.9).length > 40, 'a straight road reads as straight');
});

test('paintRoads: asphalt, kerb, white lines and pavement; buildings stay transparent', () => {
  const painted = paintRoads(w.field, w.skeleton);
  const at = (x, z) => {
    const i = (Math.floor((z - painted.z0) / painted.pixel) * painted.width + Math.floor((x - painted.x0) / painted.pixel)) * 4;
    return [...painted.data.slice(i, i + 4)];
  };
  const near = (rgba, hex, tol = 12) => [16, 8, 0].every((shift, k) => Math.abs(rgba[k] - ((hex >> shift) & 255)) <= tol);
  assert.equal(at(0, 20)[3], 0, 'building: transparent');
  assert.equal(at(0, 27)[3], 0, 'no ground: transparent');
  assert.ok(near(at(3, 3.2), ROAD_COLORS.asphalt), `asphalt ${at(3, 3.2)}`);
  assert.ok(near(at(2, 5.35), ROAD_COLORS.pavement, 14) || near(at(2, 5.35), ROAD_COLORS.joint, 14), `pavement ${at(2, 5.35)}`);
  let stripes = 0, kerb = 0;
  for (let z = -6; z < 6; z += 0.05) { // across the road at one x
    const px = at(1.3, z);
    if (near(px, ROAD_COLORS.stripe, 4)) stripes++;
    if (near(px, ROAD_COLORS.kerb, 14)) kerb++;
  }
  assert.ok(stripes > 0, 'white edge lines');
  assert.ok(kerb > 0, 'kerbs');
  let dashes = 0;
  for (let x = -30; x < 30; x += 0.1) if (near(at(x, 0), ROAD_COLORS.stripe, 4)) dashes++;
  assert.ok(dashes > 40 && dashes < 400, `a dashed centre line, not a solid one nor none: ${dashes} white samples in 60 m`);
});

const CAR = { length: 3.8, width: 2.1, height: 1.6, radius: 2.2 };
const roadCars = (extra = {}) => planRoadCars({ skeleton: w.skeleton, field: w.field, rand: random(5), car: CAR, ...extra });

test('planRoadCars: cars sit wholly on asphalt, drive on the right, keep their gaps, and respect visibility', () => {
  const cars = roadCars();
  assert.ok(cars.length >= 6, `${cars.length} cars on a 70 m road`);
  for (const car of cars) {
    assert.equal(car.y, SURFACE);
    assert.equal(car.air, false);
    const hx = Math.cos(car.yaw), hz = -Math.sin(car.yaw);
    for (const t of [-0.4, 0, 0.4]) assert.ok(sampleField(w.field, w.field.road, car.x + hx * CAR.length * t, car.z + hz * CAR.length * t) >= CAR.width / 2 - 0.2, 'on the asphalt');
    if (Math.abs(car.z) > 0.5) assert.equal(Math.sign(car.z), Math.sign(hx), 'the right-hand lane: heading +x is at +z');
    assert.ok(CAR_COLORS.includes(car.color));
  }
  assert.ok(cars.some(c => Math.cos(c.yaw) > 0) && cars.some(c => Math.cos(c.yaw) < 0), 'both directions');
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) assert.ok(Math.hypot(cars[i].x - cars[j].x, cars[i].z - cars[j].z) >= CAR.length + 1.5 - 1e-9, 'no overlapping cars');
  assert.ok(new Set(cars.map(c => c.color)).size >= 3, 'different colours');
  assert.deepEqual(roadCars(), cars, 'the same seed gives the same cars');
  const east = roadCars({ visible: x => x > 0 });
  assert.ok(east.length > 0 && east.every(c => c.x > 0), 'nothing is planned outside the visible area');
  assert.deepEqual(roadCars({ visible: () => false }), []);
  assert.ok(roadCars({ avoid: [{ x: 0, z: 0, r: 15 }] }).every(c => Math.hypot(c.x, c.z) >= 15));
  assert.ok(roadCars({ max: 3 }).length <= 3);
  const gap = roadCars({ gap: [20, 20] });
  const same = gap.filter(c => Math.cos(c.yaw) > 0).sort((a, b) => a.x - b.x);
  for (let i = 1; i < same.length; i++) assert.ok(same[i].x - same[i - 1].x >= 20 - 1e-6, 'cars going the same way keep the gap');
});

test('planAirCars never puts a car inside the model, honours visibility and avoid zones, and is repeatable', () => {
  const inAir = (extra = {}) => planAirCars({
    clearance: w.clearance, rand: random(7), car: CAR, spacing: 12, max: 14, altitudes: [4, 9, 15, 24],
    bounds: { minX: -38, maxX: 38, minZ: -24, maxZ: 24 }, ...extra,
  });
  const cars = inAir();
  assert.ok(cars.length >= 3 && cars.length <= 14, `${cars.length} cars`);
  for (const car of cars) {
    assert.ok(w.clearance.clear(car.x, car.z, CAR.radius, car.y - 0.4, car.y + CAR.height + 0.4), `car at ${car.x.toFixed(1)}, ${car.y}, ${car.z.toFixed(1)} is inside the city`);
    assert.equal(car.air, true);
  }
  assert.ok(cars.some(c => Math.abs(c.z) > 8 && c.y > 20), 'above the roofs counts as open air');
  assert.deepEqual(inAir(), cars);
  assert.ok(inAir({ visible: x => x > 0 }).every(c => c.x > 0));
  assert.ok(inAir({ avoid: [{ x: 0, z: 0, r: 12 }] }).every(c => Math.hypot(c.x, c.z) >= 12));
});

test('planLamps: on the pavement beside the road, spaced, near the blocks, away from them, repeatable', () => {
  const lamps = (extra = {}) => planLamps({ ...w, rand: random(1), around: { x: 0, z: 0 }, radius: 40, gap: 12, max: 12, ...extra });
  const list = lamps();
  assert.ok(list.length >= 4, `${list.length} lamps`);
  for (const lamp of list) {
    assert.ok(Math.abs(lamp.z) > 4.8 && Math.abs(lamp.z) < 6, `on the pavement strip: z ${lamp.z.toFixed(2)}`);
    assert.ok(Math.hypot(lamp.x, lamp.z) <= 40);
    assert.ok(Math.sign(Math.sin(lamp.yaw)) === Math.sign(lamp.z), 'the arm points at the road (-z side lamps point +z: -sin(yaw) is the z of the arm)'.length > 0 ? true : true);
    assert.ok(Math.abs(-Math.sin(lamp.yaw) * lamp.z) < 1e-9 || -Math.sin(lamp.yaw) * lamp.z < 0, 'the arm points toward the middle of the road');
  }
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z) >= 12 - 1e-9);
  for (let i = 1; i < list.length; i++) assert.ok(Math.hypot(list[i].x, list[i].z) >= Math.hypot(list[i - 1].x, list[i - 1].z) - 1e-9, 'nearest first, so ids are stable');
  assert.deepEqual(lamps(), list);
  assert.ok(lamps({ avoid: [{ x: 0, z: 0, r: 15 }] }).every(l => Math.hypot(l.x, l.z) >= 15));
  assert.ok(lamps({ max: 3 }).length <= 3);
});

test('lampSpec is a valid shared assembly with a glowing lamp, and builds into a grounded, movable object', () => {
  const spec = lampSpec({ x: 3, z: -2, yaw: 1.2, color: '#ff7ad9' }, 4);
  assert.equal(protocol.module.validAssembly(spec), true);
  assert.equal(spec.id, 'lamp-4');
  assert.equal(protocol.module.renderSpec(spec).parts.find(p => p.id === 'lamp').emissive, '#ff7ad9', 'the glow survives the whitelist');
  const root = objects.module.createAssembly(spec);
  const lit = root.children.find(m => m.name === 'lamp').material;
  assert.equal(lit.emissive.getHexString(), 'ff7ad9');
  assert.ok(root.children.filter(m => m.name !== 'lamp').every(m => m.material.emissive.getHex() === 0), 'only the lamp head glows');
  const bounds = new THREE.Box3().setFromObject(root);
  assert.ok(Math.abs(bounds.min.y - SURFACE) < 1e-6, 'its base is on the road');
  assert.ok(Math.abs(bounds.max.y - bounds.min.y - 9.74) < 0.1, `a 9.7 m lamp: ${bounds.max.y - bounds.min.y}`);
  assert.equal(protocol.module.validAssembly({ ...spec, parts: [{ ...spec.parts[0], emissive: 'red' }] }), false, 'a bad glow colour is rejected');
});

test('lampSpec positions are relative to the blocks group, so a lamp lands where it was planned', () => {
  const blocks = new THREE.Group();
  blocks.position.set(14, 0, -1); // the workspace
  const lamp = { x: 20, z: 5, yaw: 0.7, color: '#5fe9ff' };
  const root = objects.module.createAssembly(lampSpec(lamp, 0, [14, -1]));
  blocks.add(root);
  blocks.updateMatrixWorld(true);
  const base = root.children.find(m => m.name === 'base').getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(base.x - 20) < 1e-9 && Math.abs(base.z - 5) < 1e-9, `base at ${base.x}, ${base.z}`);
  assert.ok(Math.abs(lampSpec(lamp, 0, [14, -1]).position[0] - 6) < 1e-9, 'stored relative to the workspace');
});

test('sync.adopt: a lamp built locally is carried by the host scene, recipe included, and can be held', () => {
  const blocks = new THREE.Group();
  const fake = { register() {}, unregister() {} };
  const made = new objects.module.Objects(blocks, fake);
  const host = new sync.module.SceneSync(blocks, { userId: 'A', hostId: 'A', objects: made });
  const lamp = made.add(lampSpec({ x: 1, z: 2, yaw: 0, color: '#5fe9ff' }, 0), { place: false, remember: false, notify: false });
  assert.equal(host.meshes.has('lamp-0'), false, 'a plain add is not known to the sync');
  host.adopt(lamp);
  const scene = host.sceneSnapshot(1000);
  const entry = scene.objects.find(o => o.id === 'lamp-0');
  assert.ok(entry && entry.kind === 'assembly' && entry.spec.parts.length === 4, 'the first scene carries the recipe');
  assert.deepEqual(entry.pos.map(v => +v.toFixed(3)), [1, SURFACE, 2]);
  assert.equal(host.snapshotHeld(new Set(['lamp-0']))[0].id, 'lamp-0', 'holding it streams its pose');
  host.sceneSent(true);
  assert.equal(made.history.length, 0, 'lamps are not undoable');
});

test('airshipAt: a level circle round the centre, one lap per period, flying nose first', () => {
  const orbit = { center: [14, -1], radius: 95, height: 50, period: 300 };
  const state = {};
  let last = airshipAt(state, 0, orbit), travelled = 0, steps = 0;
  const laps = [];
  for (let t = 0; t < 600; t += 0.5) {
    const now = airshipAt(state, 0.5, orbit);
    assert.ok(Math.abs(Math.hypot(now.position.x - 14, now.position.z + 1) - 95) < 1e-9, 'on the circle');
    assert.equal(now.position.y, 50, 'a set height');
    const move = now.position.clone().sub(last.position);
    travelled += move.length(); steps++;
    const heading = new THREE.Vector3(Math.cos(now.yaw), 0, -Math.sin(now.yaw)); // where a +x nose points
    assert.ok(move.normalize().dot(heading) > 0.999, 'it flies the way its nose points');
    last = now;
    if (t === 299.5) laps.push(now.position.clone());
  }
  assert.ok(Math.abs(travelled - 2 * 2 * Math.PI * 95) < 5, `two laps in 600 s: ${travelled.toFixed(0)} m`);
  assert.ok(laps[0].distanceTo(airshipAt({}, 0, { ...orbit, start: 0 }).position) < 1, 'back at the start after one period');
  assert.ok(2 * Math.PI * 95 / 300 < 2.5, 'slow: about 2 m/s');
  assert.notEqual(airshipAt({}, 0, { ...orbit, start: 1 }).position.x, airshipAt({}, 0, { ...orbit, start: 0 }).position.x, 'the start angle can differ');
});

test('mergeByLook: similar materials share one mesh, triangles are kept, placement is kept', () => {
  const root = new THREE.Group();
  const grey = mat(0x808080), alike = mat(0x828282), red = mat(0xff0000), glow = mat(0xff0000, { emissive: 0xff0000 });
  root.add(box(1, 1, 1, 0, 0, 0, grey), box(1, 1, 1, 3, 0, 0, alike), box(1, 1, 1, 0, 3, 0, red), box(1, 1, 1, 0, 0, 3, glow));
  root.children[1].scale.x = -1; // a mirrored part must not come out inside out
  const parts = mergeByLook(root);
  assert.equal(parts.length, 3, 'grey+alike, red, glowing red');
  assert.equal(parts.reduce((n, p) => n + p.triangles, 0), 48);
  const all = new THREE.Box3();
  for (const p of parts) all.union(p.geometry.boundingBox);
  assert.deepEqual(all.min.toArray().map(v => +v.toFixed(3)), [-0.5, -0.5, -0.5]);
  assert.deepEqual(all.max.toArray().map(v => +v.toFixed(3)), [3.5, 3.5, 3.5]);
  const greyPart = parts.find(p => p.material === grey).geometry;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cross = new THREE.Vector3();
  const index = greyPart.index, position = greyPart.attributes.position, normal = greyPart.attributes.normal;
  for (let t = 0; t < index.count; t += 3) {
    a.fromBufferAttribute(position, index.getX(t)); b.fromBufferAttribute(position, index.getX(t + 1)); c.fromBufferAttribute(position, index.getX(t + 2));
    cross.crossVectors(b.clone().sub(a), c.clone().sub(a));
    assert.ok(cross.dot(new THREE.Vector3().fromBufferAttribute(normal, index.getX(t))) > 0, 'every face winds the way its normal points');
  }
});

test('buildWallE is about the asked height, grounded, and fits beside the blocks', () => {
  const wall = buildWallE(1.1);
  const bounds = new THREE.Box3().setFromObject(wall), size = bounds.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.y - 1.1) < 0.08, `height ${size.y}`);
  assert.ok(Math.abs(bounds.min.y) < 0.01, 'stands on y = 0');
  assert.ok(size.x < 1 && size.z < 1);
});

test('carParts: length, nose toward +x from the lights, wheels on y = 0; the body is its own tintable part; Cars draws every look once', () => {
  const root = new THREE.Group();
  const body = mat(new THREE.Color(0.5, 0.02, 0.05)), glass = mat(0x111111);
  const head = mat(0xffffff, { emissive: new THREE.Color(0.2, 0.5, 0.9) }), tail = mat(0xffffff, { emissive: new THREE.Color(0.9, 0.1, 0.1) });
  assert.equal(isCarBody(body), true);
  assert.equal(isCarBody(glass), false);
  assert.equal(isCarBody(head), false);
  // Built with its nose toward -x, to prove the nose is found from the lights and not assumed.
  root.add(box(300, 60, 160, 10, 80, 5, body), box(100, 50, 150, 10, 130, 5, glass), box(10, 10, 30, -150, 70, 5, head), box(10, 10, 30, 160, 70, 5, tail));
  root.rotation.x = -Math.PI / 2; // the way Sketchfab exports sit
  const car = carParts(root, 3.8);
  assert.ok(Math.abs(car.length - 3.8) < 0.01 || Math.abs(car.width - 3.8) < 0.01, `length ${car.length} x ${car.width}`);
  const headPart = car.parts.find(p => p.material === head), tailPart = car.parts.find(p => p.material === tail);
  assert.ok(headPart.geometry.boundingBox.getCenter(new THREE.Vector3()).x > tailPart.geometry.boundingBox.getCenter(new THREE.Vector3()).x, 'the headlights are at +x: the nose points +x');
  const bounds = new THREE.Box3();
  for (const p of car.parts) bounds.union(p.geometry.boundingBox);
  assert.ok(Math.abs(bounds.min.y) < 1e-6, 'wheels on y = 0');
  const paint = car.parts.find(p => p.key === 'body').material;
  assert.equal(paint.color.getHex(), 0xffffff, 'white, so the per-car colour is the colour');
  assert.notEqual(paint, body, 'the shared material is not touched');
  const cars = new Cars(car, [{ x: 1, y: 0, z: 2, yaw: 0, air: false, color: 0xff0000 }, { x: 5, y: 9, z: 2, yaw: 1, air: true, color: 0x00ff00 }]);
  assert.equal(cars.meshes.length, car.parts.length, 'one instanced mesh per look, for any number of cars');
  const bodyMesh = cars.meshes[car.parts.findIndex(p => p.key === 'body')];
  assert.ok(bodyMesh.instanceColor, 'per-car colours');
  const at = new THREE.Matrix4(), p = new THREE.Vector3();
  bodyMesh.getMatrixAt(1, at);
  p.setFromMatrixPosition(at);
  assert.ok(Math.abs(p.x - 5) < 1e-6 && Math.abs(p.y - 9) < 0.31, 'hovering car near its height');
  cars.update(3.3);
  bodyMesh.getMatrixAt(0, at);
  assert.deepEqual(p.setFromMatrixPosition(at).toArray(), [1, 0, 2], 'a parked car never moves');
  assert.ok(bodyMesh.boundingSphere, 'bounds for culling');
});

test('Cars are instanced per square of the city, so squares out of view cost nothing', () => {
  const root = new THREE.Group();
  root.add(box(300, 60, 160, 0, 80, 0, mat(new THREE.Color(0.5, 0.02, 0.05))), box(100, 50, 150, 0, 130, 0, mat(0x111111)));
  const car = carParts(root, 3.8);
  const make = (x, z) => ({ x, y: 0, z, yaw: 0, air: false, color: 0xff0000 });
  const cars = new Cars(car, [make(0, 0), make(5, 3), make(210, 0), make(-130, 90)], { chunk: 50 });
  assert.equal(cars.chunks.length, 3, 'three squares: the first two cars share one');
  assert.equal(cars.meshes.length, 3 * car.parts.length);
  assert.deepEqual(cars.chunks.map(c => c.entries.length).sort(), [1, 1, 2]);
  const spheres = cars.meshes.map(m => m.boundingSphere);
  assert.ok(spheres.every(sphere => sphere && sphere.radius < 20), 'each square has its own small bounds to cull with');
  const far = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  far.position.set(0, 2, 40);
  far.lookAt(0, 2, 0);
  far.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(far.projectionMatrix, far.matrixWorldInverse));
  const visible = cars.chunks.filter(c => c.meshes.some(m => frustum.intersectsSphere(m.boundingSphere)));
  assert.equal(visible.length, 1, 'only the square in front of the camera is drawn');
});

test('JunctionLights: three instanced meshes for any number of junctions, one light each, floating over the road', () => {
  const lights = new JunctionLights([{ x: 4, z: 6 }, { x: -20, z: 9 }, { x: 33, z: -8 }], { height: 7.5 });
  assert.equal(lights.meshes.length, 3, 'a disc, its glowing underside and a cone of light');
  assert.ok(lights.meshes.every(m => m.count === 3));
  const at = new THREE.Matrix4(), p = new THREE.Vector3();
  lights.meshes[0].getMatrixAt(1, at);
  p.setFromMatrixPosition(at);
  assert.ok(Math.abs(p.x + 20) < 1e-9 && Math.abs(p.z - 9) < 1e-9 && Math.abs(p.y - (SURFACE + 7.5)) < 0.16, 'the disc floats about 7.5 m above its junction');
  lights.meshes[2].getMatrixAt(1, at);
  assert.ok(Math.abs(p.setFromMatrixPosition(at).y - (SURFACE + 3.75)) < 1e-6, 'the cone runs from the light to the road');
  assert.notEqual(lights.meshes[1].instanceColor.getX(0) + lights.meshes[1].instanceColor.getY(0), lights.meshes[1].instanceColor.getX(1) + lights.meshes[1].instanceColor.getY(1), 'neighbouring lights differ in colour');
  lights.update(2);
  lights.meshes[0].getMatrixAt(1, at);
  assert.ok(Math.abs(p.setFromMatrixPosition(at).y - (SURFACE + 7.5)) <= 0.151, 'bobbing stays small');
  assert.ok(lights.meshes.every(m => m.boundingSphere), 'bounds for culling');
  assert.equal(new JunctionLights([]).meshes[0].count, 0, 'no junctions, no lights');
});

test('cars patrol: planned runs stay on asphalt or in clear air, and Cars drives them back and forth, turning at the ends', () => {
  const road = planRoadCars({ skeleton: w.skeleton, field: w.field, rand: random(5), car: CAR });
  const moving = road.filter(c => c.speed > 0);
  assert.ok(moving.length >= 4, `${moving.length} of ${road.length} road cars drive`);
  for (const car of moving) {
    assert.ok(car.range[0] <= 0 && car.range[1] >= 0 && car.range[1] - car.range[0] >= 6);
    assert.ok(car.speed >= 2.5 && car.speed <= 5);
    for (const end of car.range) {
      const x = car.x + Math.cos(car.yaw) * end, z = car.z - Math.sin(car.yaw) * end;
      assert.ok(sampleField(w.field, w.field.road, x, z) >= CAR.width / 2 - 0.2, `the end of its run at ${end.toFixed(1)} m is still road`);
    }
  }
  const air = planAirCars({ clearance: w.clearance, rand: random(7), car: CAR, spacing: 12, max: 14, altitudes: [4, 9, 15, 24], bounds: { minX: -38, maxX: 38, minZ: -24, maxZ: 24 } });
  assert.ok(air.some(c => c.speed > 0));
  for (const car of air.filter(c => c.speed > 0)) {
    assert.ok(car.speed >= 5 && car.speed <= 9);
    for (const end of car.range) {
      const x = car.x + Math.cos(car.yaw) * end, z = car.z - Math.sin(car.yaw) * end;
      assert.ok(w.clearance.clear(x, z, CAR.radius - 0.5, car.y - 0.4, car.y + CAR.height + 0.4), 'clear air at the end of its run');
    }
  }

  const root3 = new THREE.Group();
  root3.add(box(300, 60, 160, 0, 80, 0, mat(new THREE.Color(0.5, 0.02, 0.05))), box(100, 50, 150, 0, 130, 0, mat(0x111111)));
  const parts = carParts(root3, 3.8);
  const plan = [
    { x: 0, y: 0, z: 0, yaw: 0, air: false, color: 0xff0000, range: [-3, 5], speed: 4 },
    { x: 0, y: 0, z: 4, yaw: Math.PI / 2, air: false, color: 0x00ff00, range: [0, 0], speed: 0 },
  ];
  const cars = new Cars(parts, plan, { chunk: 50 });
  const [driver, parked] = cars.chunks[0].entries;
  const mesh = cars.meshes[parts.parts.findIndex(p => p.key === 'body')];
  const at = new THREE.Matrix4(), p = new THREE.Vector3();
  let lowest = Infinity, highest = -Infinity, turns = 0, lastDir = 1, seconds = 0;
  for (let step = 0; step < 400; step++) {
    seconds += 0.05;
    cars.update(seconds);
    lowest = Math.min(lowest, driver.s); highest = Math.max(highest, driver.s);
    if (driver.dir !== lastDir) { turns++; lastDir = driver.dir; }
    assert.ok(driver.s >= -3 - 1e-9 && driver.s <= 5 + 1e-9, `stays in its run: ${driver.s}`);
  }
  assert.ok(highest > 4.99 && lowest < -2.99, `it drives the whole run: ${lowest.toFixed(2)} to ${highest.toFixed(2)}`);
  assert.ok(turns >= 3, `and turns round at each end (${turns} turns in 20 s)`);
  const fresh = new Cars(parts, [{ ...plan[0] }], { chunk: 50 });
  fresh.update(0);
  for (let step = 1; step <= 20; step++) fresh.update(step * 0.05);
  assert.ok(Math.abs(fresh.chunks[0].entries[0].s - 4) < 1e-6, `one second at 4 m/s covers 4 m: ${fresh.chunks[0].entries[0].s}`);
  mesh.getMatrixAt(0, at);
  p.setFromMatrixPosition(at);
  assert.ok(Math.abs(p.x - driver.s) < 1e-6 && Math.abs(p.z) < 1e-6, 'the instance follows it along its heading');
  assert.equal(parked.s, 0, 'a parked car does not move');
  mesh.getMatrixAt(1, at);
  assert.deepEqual(p.setFromMatrixPosition(at).toArray().map(v => +v.toFixed(3)), [0, 0, 4]);
  assert.ok(cars.chunks[0].reach === 5 && mesh.boundingSphere.radius >= 5 + 2, 'the square\'s bounds cover the patrol');
  const before = driver.s;
  cars.update(seconds + 5); // a stalled tab: the cars take one capped step, they do not jump
  assert.ok(Math.abs(driver.s - before) <= 4 * 0.1 + 1e-9, 'a long gap moves a car at most 0.1 s of driving');
});

test('separatePatrols trims runs so cars in a lane never meet, and leaves other lanes and heights alone', () => {
  const dims = { length: 3.8, width: 2.1 };
  const car = (x, z, extra = {}) => ({ x, y: 0.02, z, yaw: 0, air: false, color: 0xff0000, range: [-8, 8], speed: 3, ...extra });
  const meet = (plan, a, b) => { // the closest two cars could ever get along the shared lane
    let closest = Infinity;
    for (let sa = plan[a].range[0]; sa <= plan[a].range[1] + 1e-9; sa += 0.25) for (let sb = plan[b].range[0]; sb <= plan[b].range[1] + 1e-9; sb += 0.25) {
      closest = Math.min(closest, Math.hypot(plan[a].x + sa - plan[b].x - sb, plan[a].z - plan[b].z));
    }
    return closest;
  };
  const same = separatePatrols([car(0, 0), car(10, 0)], dims);
  assert.ok(meet(same, 0, 1) >= dims.length + 1 - 1e-6, `same lane: ${meet(same, 0, 1).toFixed(2)} m apart at the closest`);
  assert.ok(same[1].range[1] - same[1].range[0] <= 16, 'the second car\'s run was shortened');
  const crowded = separatePatrols([car(0, 0), car(5.4, 0)], dims);
  assert.equal(crowded[1].speed, 0, 'no room to patrol: it parks');
  assert.deepEqual(crowded[1].range, [0, 0]);
  const lanes = separatePatrols([car(0, 0), car(10, 3.2, { yaw: Math.PI })], dims); // the other lane, going the other way
  assert.deepEqual(lanes[1].range, [-8, 8], 'opposite lanes never meet, so nothing is trimmed');
  const high = separatePatrols([car(0, 0), car(10, 0, { y: 9, air: true })], dims);
  assert.deepEqual(high[1].range, [-8, 8], 'a hovering car above is not in the way');
  const parked = separatePatrols([car(8, 0, { speed: 0, range: [0, 0] }), car(0, 0)], dims);
  assert.ok(parked[1].range[1] < 8, 'a parked car in the way trims the run');
  assert.deepEqual(separatePatrols([car(0, 0), car(10, 0)], dims), same, 'deterministic');
});
