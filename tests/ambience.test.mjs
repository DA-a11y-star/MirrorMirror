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
const amb = (await load('ambience', { 'set-layout': layout.url, roads: roads.url })).module;
const { buildClearance } = scenery.module;
const { roadField, roadSkeleton } = roads.module;
const { random } = layout.module;
const {
  glowTexture, fireworkBurst, fireworkShow, skyLanterns, petals, steam, halos, fireworks, rain, openGroundLevels, wallAhead,
  planLanternStrings, planFestivalArches, festivalFrames, anchorSigns, WetStreet, lanternsOn, LanternStrings, planFloorLanterns, lanternSpec, planSigns, signPatterns, Signs, planVents, GlowPools, hologram, NEON_COLORS,
} = amb;

const mat = new THREE.MeshStandardMaterial();
const box = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; };
// A street 6 m wide along x between two 20 m buildings (|z| from 3 to 23), so walls stand 3 m either side of its middle.
function town(oneSide = false, gap = 3, minHalf = 1.3) {
  const root = new THREE.Group();
  root.add(box(90, 20, 20, 0, 10, gap + 10));
  if (!oneSide) root.add(box(90, 20, 20, 0, 10, -gap - 10));
  else { const speck = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat); speck.position.set(0, 0, -12); root.add(speck); } // flat: widens the map, blocks nothing
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root).expandByVector(new THREE.Vector3(0, 0, 0));
  bounds.min.z = oneSide ? -8 : -gap - 20; bounds.max.z = gap + 20; // (one-sided: a street 11 m wide, so it still has a middle line)
  const clearance = buildClearance(root, { cell: 0.25, margin: 6 });
  const field = roadField(clearance, openGroundLevels(clearance, bounds), { sidewalk: 0.2 });
  return { clearance, field, skeleton: roadSkeleton(field, { minHalf }), bounds };
}
const t = town();

const finite = array => array.every(Number.isFinite);

test('glowTexture is a soft round glow: opaque in the middle, clear at the corners', () => {
  const texture = glowTexture(32);
  const alpha = (x, y) => texture.image.data[(y * 32 + x) * 4 + 3];
  assert.ok(alpha(16, 16) > 225 && alpha(0, 0) === 0 && alpha(16, 4) > alpha(16, 1));
});

test('fireworkBurst is a pure function of slot and lap, inside the ring and height range, and varies', () => {
  const cfg = { center: [10, -5], ring: [25, 60], heights: [26, 44] };
  const a = fireworkBurst(2, 7, cfg), b = fireworkBurst(2, 7, cfg);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, fireworkBurst(2, 8, cfg), 'another lap, another burst');
  assert.notDeepEqual(a, fireworkBurst(3, 7, cfg), 'another slot, another burst');
  for (let slot = 0; slot < 6; slot++) for (let lap = 0; lap < 30; lap++) {
    const { center, color } = fireworkBurst(slot, lap, cfg);
    const r = Math.hypot(center[0] - 10, center[2] + 5);
    assert.ok(r >= 25 - 1e-9 && r <= 60 + 1e-9 && center[1] >= 26 && center[1] <= 44, `burst ${slot}/${lap} at r ${r.toFixed(1)}, y ${center[1].toFixed(1)}`);
    assert.ok(color.every(v => v >= 0 && v <= 1));
  }
});

test('fireworkShow staggers its slots, lights each for `life` seconds of every period, and repeats with the clock', () => {
  const cfg = { slots: 6, period: 7, life: 3.2 };
  const at = time => fireworkShow(time, cfg);
  assert.equal(at(100).length, 6);
  const ages = at(100).map(s => s.age);
  assert.ok(ages.every(a => a === -1 || (a >= 0 && a < 3.2)), JSON.stringify(ages));
  assert.ok(new Set(at(100).map(s => s.age.toFixed(2))).size > 1, 'slots are staggered');
  assert.deepEqual(at(123.4), at(123.4), 'same clock, same sky (so both laptops agree)');
  let lit = 0;
  for (let time = 0; time < 70; time += 0.5) lit += at(time).filter(s => s.age >= 0).length;
  assert.ok(Math.abs(lit / (140 * 6) - 3.2 / 7) < 0.06, `each slot is lit about ${(3.2 / 7 * 100).toFixed(0)}% of the time`);
  const first = fireworkShow(10, cfg)[0], later = fireworkShow(10 + 0.5, cfg)[0];
  if (first.age >= 0 && later.age >= 0) assert.deepEqual(first.burst, later.burst, 'a burst stays where it went off');
});

test('the particle effects build the right buffers, with finite values, and take the clock', () => {
  const rand = random(3);
  const count = o => o.object.geometry.attributes.position.count;
  const effects = {
    sky: skyLanterns({ count: 40, center: [0, 0], rand }), petals: petals({ count: 50, rand }),
    steam: steam({ vents: [[1, 2], [5, 6]], per: 10, rand }), halos: halos({ points: [[0, 1, 2, 3], [4, 5, 6, 2]], colors: [[1, 0, 0]], rand }),
    fireworks: fireworks({ slots: 3, per: 20, rand }),
  };
  assert.equal(count(effects.sky), 40);
  assert.equal(count(effects.petals), 50);
  assert.equal(count(effects.steam), 20);
  assert.equal(count(effects.halos), 2);
  assert.equal(count(effects.fireworks), 60);
  for (const [name, effect] of Object.entries(effects)) {
    const g = effect.object.geometry;
    for (const key of ['position', 'aSeed', 'aColor']) assert.ok(finite(g.attributes[key].array), `${name} ${key} is finite`);
    assert.equal(effect.object.frustumCulled, false, 'its points move in the shader');
    assert.equal(effect.object.material.depthWrite, false);
    effect.update(12.5, { fov: 55, position: new THREE.Vector3(3, 2, 1) });
    assert.equal(effect.object.material.uniforms.uTime.value, 12.5);
    assert.deepEqual(effect.object.material.uniforms.uCamera.value.toArray(), [3, 2, 1]);
  }
  const shader = effects.fireworks.object.material.vertexShader;
  assert.ok(shader.includes('uBurst[3]'), 'the shader array matches the slot count');
  effects.fireworks.update(0, null);
  const bursts = effects.fireworks.object.material.uniforms.uBurst.value;
  assert.equal(bursts.length, 3);
  assert.ok(bursts.every(b => finite(b.toArray())));
  const dirs = effects.fireworks.object.geometry.attributes.aDir.array;
  for (let i = 0; i < dirs.length; i += 3) assert.ok(Math.abs(Math.hypot(dirs[i], dirs[i + 1], dirs[i + 2]) - 1) < 1e-5, 'spark directions are unit vectors');
});

test('rain is a vertical pair of vertices per streak, in a volume that follows the camera', () => {
  const r = rain({ count: 100, rand: random(2) });
  const g = r.object.geometry;
  assert.equal(g.attributes.position.count, 200);
  assert.deepEqual([...g.attributes.aEnd.array.slice(0, 4)], [0, 1, 0, 1]);
  assert.ok(finite(g.attributes.position.array));
  r.update(4, { position: new THREE.Vector3(7, 1, 9) });
  assert.deepEqual(r.object.material.uniforms.uCamera.value.toArray(), [7, 1, 9]);
  assert.ok(r.object.isLineSegments);
});

test('openGroundLevels makes everything inside the box open street and everything outside no ground', () => {
  const { clearance, bounds } = t;
  const levels = openGroundLevels(clearance, bounds);
  const at = (x, z) => levels[Math.floor((z - clearance.z0) / 0.25) * clearance.w + Math.floor((x - clearance.x0) / 0.25)];
  assert.equal(at(0, 0), 1);
  assert.equal(at(0, 26), 0, 'beyond the box, though inside the map');
});

test('planLanternStrings hangs strings wall to wall across the street, at a height with walls both sides, spaced out and repeatable', () => {
  const plan = (extra = {}) => planLanternStrings({ skeleton: t.skeleton, clearance: t.clearance, rand: random(5), ...extra });
  const strings = plan();
  assert.ok(strings.length >= 4, `${strings.length} strings on a 90 m street`);
  for (const s of strings) {
    const span = Math.hypot(s.b[0] - s.a[0], s.b[2] - s.a[2]);
    assert.ok(span >= 3 && span <= 9.5, `span ${span.toFixed(2)}`);
    assert.ok(Math.abs(Math.abs(s.a[2]) - 3) < 0.45 && Math.abs(Math.abs(s.b[2]) - 3) < 0.45 && s.a[2] * s.b[2] < 0, `anchored on the two walls (z ${s.a[2].toFixed(2)}, ${s.b[2].toFixed(2)})`);
    assert.equal(s.a[1], 4.4, 'the first height wins when walls reach it');
    assert.ok(s.count >= 3);
  }
  for (let i = 0; i < strings.length; i++) for (let j = i + 1; j < strings.length; j++) {
    assert.ok(Math.abs((strings[i].a[0] + strings[i].b[0]) / 2 - (strings[j].a[0] + strings[j].b[0]) / 2) >= 6.9, 'spaced out along the street');
  }
  assert.deepEqual(plan(), strings);
  assert.ok(plan({ maxSpan: 4 }).length === 0, 'a 6 m street is too wide for a 4 m limit');
  const alley = town(false, 1, 0.4); // walls only 2 m apart: too narrow to bother with
  assert.ok(alley.skeleton.some(p => p.line >= 0.85), 'the alley has a middle line, so the test means something');
  assert.equal(planLanternStrings({ skeleton: alley.skeleton, clearance: alley.clearance, rand: random(5) }).length, 0, 'an alley narrower than minSpan gets none');
  const lone = town(true);
  assert.ok(lone.skeleton.some(p => p.line >= 0.85), 'the lone-wall street has a middle line, so the test means something');
  assert.equal(planLanternStrings({ skeleton: lone.skeleton, clearance: lone.clearance, rand: random(5) }).length, 0, 'no string without a wall on both sides');
});

test('lanternsOn hangs lanterns along a sagging rope, lower in the middle, each below the rope', () => {
  const lanterns = lanternsOn([{ a: [0, 4, 0], b: [8, 4, 0], sag: 0.6, count: 8 }], random(1));
  assert.equal(lanterns.length, 8);
  assert.ok(lanterns.every(l => l.y < 4 - 0.4 && l.y > 4 - 0.45 - 0.61));
  assert.ok(lanterns[3].y < lanterns[0].y && lanterns[4].y < lanterns[7].y, 'lowest in the middle');
  assert.ok(lanterns.every((l, i) => i === 0 || l.x > lanterns[i - 1].x), 'spread along the rope');
});

test('festival arches have real grounded posts and a crossbeam, and reject obstructed sites', () => {
  const plan = () => planFestivalArches({ skeleton: t.skeleton, clearance: t.clearance });
  const strings = plan();
  assert.ok(strings.length >= 3);
  assert.deepEqual(plan(), strings);
  for (const s of strings) {
    assert.equal(s.supported, true);
    assert.ok(Math.hypot(s.x, s.z) >= 6, 'keeps the demonstration area open');
    assert.ok([s.a, s.b].every(v => t.clearance.clear(v[0], v[2], 0.32, 0.1, v[1] + 0.65)));
  }
  assert.deepEqual(planFestivalArches({ skeleton: t.skeleton, clearance: { clear: () => false } }), [], 'no posts inside buildings');
  const blockedBeam = { clear: (x, z, radius, low) => low < 1 };
  assert.deepEqual(planFestivalArches({ skeleton: t.skeleton, clearance: blockedBeam }), [], 'no crossbeam through a roof');
  const frames = festivalFrames(strings);
  assert.equal(frames.children.length, 3, 'instanced wood, gold, roof');
  const matrix = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), scale = new THREE.Vector3();
  frames.children[0].getMatrixAt(0, matrix); matrix.decompose(p, q, scale);
  assert.ok(Math.abs(p.y - scale.y / 2) < 1e-6, 'post bottom is grounded');
  assert.ok(Math.hypot(p.x - strings[0].a[0], p.z - strings[0].a[2]) < 1e-5, 'rope endpoint is on the actual post');
});

test('smaller hanging lanterns remain connected to the rope while they sway', () => {
  const string = { a: [0, 4.6, 0], b: [5, 4.6, 0], sag: 0.3, count: 5, supported: true };
  const effect = new LanternStrings([string], random(1));
  const matrix = new THREE.Matrix4(), v = new THREE.Vector3();
  for (const time of [0, 1.7, 100]) {
    effect.update(time);
    effect.lanterns.forEach((l, i) => {
      assert.ok(l.size <= 0.7);
      effect.cords.getMatrixAt(i, matrix);
      const ends = [-0.5, 0.5].map(y => new THREE.Vector3(0, y, 0).applyMatrix4(matrix));
      const anchor = new THREE.Vector3(l.x, l.y + 0.45, l.z);
      assert.ok(Math.min(...ends.map(p => p.distanceTo(anchor))) < 1e-5, 'cord reaches the fixed rope pivot');
      effect.caps.getMatrixAt(i, matrix);
      v.set(0, 0.45, 0).applyMatrix4(matrix);
      assert.ok(Math.min(...ends.map(p => p.distanceTo(v))) < 1e-5, 'other end reaches the swaying cap');
    });
  }
});

test('signs attach to real triangles, never to a filled occupancy volume', () => {
  const city = new THREE.Group(); city.add(box(10, 10, 1, 0, 5, 0));
  const sign = { x: 0, y: 4, z: 1, yaw: 0, w: 2, h: 3, color: [1, 0, 0] };
  const anchored = anchorSigns(city, [sign]);
  assert.equal(anchored.length, 1);
  assert.ok(Math.abs(anchored[0].z - 0.545) < 1e-5);
  assert.deepEqual(anchorSigns(new THREE.Group(), [sign]), []);
  assert.deepEqual(anchorSigns(city, [{ ...sign, y: 14 }]), [], 'no facade above the roof');
});

test('wet street is one instanced draw with a road mask, and accepts an empty layout', () => {
  const signs = [{ x: 0, z: -3, yaw: 0, w: 2, h: 3, color: [0.2, 0.9, 1] }];
  const effect = new WetStreet(signs, t.field);
  assert.equal(effect.group.children.length, 1);
  assert.equal(effect.group.children[0].count, 1);
  assert.ok(effect.material.uniforms.uMask.value.image.data.some(v => v === 0));
  effect.update(12);
  assert.equal(effect.material.uniforms.uTime.value, 12);
  assert.equal(new WetStreet([], t.field).group.children[0].count, 0);
});

test('LanternStrings: one instanced body and cap per lantern, a rope, a halo, and they sway a little', () => {
  const strings = planLanternStrings({ skeleton: t.skeleton, clearance: t.clearance, rand: random(5) });
  const lanterns = new LanternStrings(strings, random(6));
  const n = lanterns.lanterns.length;
  assert.ok(n >= 12);
  assert.equal(lanterns.body.count, n);
  assert.equal(lanterns.caps.count, n);
  assert.equal(lanterns.ropes.geometry.attributes.position.count, strings.length * 8 * 2);
  assert.equal(lanterns.halo.object.geometry.attributes.position.count, n);
  assert.ok(lanterns.body.instanceColor, 'each lantern has its own red');
  const at = new THREE.Matrix4(), p = new THREE.Vector3();
  lanterns.update(0);
  lanterns.body.getMatrixAt(0, at);
  const before = p.setFromMatrixPosition(at).clone();
  lanterns.update(1.7);
  lanterns.body.getMatrixAt(0, at);
  const moved = p.setFromMatrixPosition(at).distanceTo(before);
  assert.ok(moved > 0 && moved < 0.1, `swings ${moved.toFixed(3)} m`);
});

test('planFloorLanterns: beside the road near the blocks, in clear ground, apart, nearest first, away from the avoided disc', () => {
  const plan = (extra = {}) => planFloorLanterns({ ...t, rand: random(2), around: { x: 0, z: 0 }, radius: [3, 20], count: 8, ...extra });
  const list = plan();
  assert.ok(list.length >= 5, `${list.length} lanterns`);
  for (const l of list) {
    assert.ok(Math.hypot(l.x, l.z) >= 3 && Math.hypot(l.x, l.z) <= 20);
    assert.ok(t.clearance.clear(l.x, l.z, 0.5, 0.1, 1.8), 'in the open');
  }
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z) >= 3.5 - 1e-9);
  for (let i = 1; i < list.length; i++) assert.ok(Math.hypot(list[i].x, list[i].z) >= Math.hypot(list[i - 1].x, list[i - 1].z) - 1e-9, 'nearest first, so ids are stable');
  assert.deepEqual(plan(), list);
  assert.ok(plan({ avoid: [{ x: 0, z: 0, r: 8 }] }).every(l => Math.hypot(l.x, l.z) >= 8));
});

test('lanternSpec is a valid shared assembly with a glowing body, standing 1.7 m tall where it was planned', () => {
  const spec = lanternSpec({ x: 20, z: 5 }, 3, [14, -1]);
  assert.equal(protocol.module.validAssembly(spec), true);
  assert.equal(spec.id, 'lantern-3');
  assert.deepEqual(spec.position.map(v => +v.toFixed(3)), [6, 0.02, 6]);
  assert.ok(spec.parts.length <= 40 && spec.parts.every(p => p.size.every(v => v > 0 && v <= 10)));
  const root = objects.module.createAssembly(spec);
  assert.equal(root.children.find(m => m.name === 'body').material.emissive.getHexString(), 'ff4a2a');
  const blocks = new THREE.Group();
  blocks.position.set(14, 0, -1);
  blocks.add(root);
  blocks.updateMatrixWorld(true);
  const base = root.children.find(m => m.name === 'base').getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(base.x - 20) < 1e-9 && Math.abs(base.z - 5) < 1e-9, 'lands at the planned world position inside the offset group');
  const bounds = new THREE.Box3().setFromObject(root);
  assert.ok(Math.abs(bounds.max.y - bounds.min.y - 1.72) < 0.1, `height ${bounds.max.y - bounds.min.y}`);
});

test('planSigns hangs neon on the walls beside the street, facing it, spaced out and repeatable', () => {
  const plan = (extra = {}) => planSigns({ skeleton: t.skeleton, clearance: t.clearance, rand: random(4), count: 40, ...extra });
  const signs = plan();
  assert.ok(signs.length >= 10 && signs.length <= 40, `${signs.length} signs`);
  for (const s of signs) {
    assert.ok(['bar', 'strip', 'panel'].includes(s.kind));
    const nx = Math.sin(s.yaw), nz = Math.cos(s.yaw); // the direction it faces: toward the street
    assert.ok(Math.abs(Math.abs(s.z) - 3) < 0.3, `on a wall (z ${s.z.toFixed(2)})`);
    assert.ok(nz * s.z < 0, 'it faces the street, away from its wall');
    assert.ok(!t.clearance.clear(s.x - nx * 0.4, s.z - nz * 0.4, 0.15, s.y - 0.4, s.y + 0.4), 'there is wall right behind it');
    assert.ok(s.y >= 5 && s.y <= 18);
    assert.ok(NEON_COLORS.some(c => c[0] === s.color[0] && c[1] === s.color[1]));
  }
  assert.ok(new Set(signs.map(s => s.kind)).size === 3, 'bars, tubes and panels');
  for (let i = 0; i < signs.length; i++) for (let j = i + 1; j < signs.length; j++) {
    assert.ok(!(Math.hypot(signs[i].x - signs[j].x, signs[i].z - signs[j].z) < 5 && Math.abs(signs[i].y - signs[j].y) < 4), 'no two signs on top of each other');
  }
  assert.deepEqual(plan(), signs);
  assert.ok(plan({ count: 5 }).length <= 5);
});

test('signPatterns makes distinct, repeatable glyph textures with a frame', () => {
  const a = signPatterns(random(1), 4, 16), b = signPatterns(random(1), 4, 16);
  assert.equal(a.length, 4);
  assert.deepEqual(a.map(p => [...p.data]), b.map(p => [...p.data]));
  assert.notDeepEqual([...a[0].data], [...a[1].data]);
  for (const { data, size } of a) {
    assert.equal(data.length, size * size * 4);
    assert.equal(data[3], 255, 'the frame is opaque at the corner');
    assert.ok(data.filter((v, i) => i % 4 === 3 && v === 255).length > size * 4, 'strokes inside the frame');
  }
});

test('Signs draws the plain neon and each glyph pattern as instances, with a halo each', () => {
  const signs = planSigns({ skeleton: t.skeleton, clearance: t.clearance, rand: random(4), count: 30 });
  const view = new Signs(signs, random(7), 4);
  assert.equal(view.meshes.reduce((n, m) => n + m.count, 0), signs.length, 'every sign is on exactly one instanced mesh');
  assert.ok(view.meshes.length <= 5, 'at most one for plain neon and one per pattern');
  assert.equal(view.halo.object.geometry.attributes.position.count, signs.length);
  assert.ok(view.meshes.every(m => m.boundingSphere));
});

test('planVents puts steam at the road edge, apart; GlowPools and hologram build what they say', () => {
  const vents = planVents({ skeleton: t.skeleton, rand: random(1), count: 5, gap: 12 });
  assert.ok(vents.length >= 3 && vents.length <= 5);
  for (let i = 0; i < vents.length; i++) for (let j = i + 1; j < vents.length; j++) assert.ok(Math.hypot(vents[i][0] - vents[j][0], vents[i][1] - vents[j][1]) >= 12 - 1e-9);
  assert.deepEqual(planVents({ skeleton: t.skeleton, rand: random(1), count: 5, gap: 12 }), vents);
  const pools = new GlowPools([{ x: 1, z: 2 }, { x: 5, z: 6 }], [0xff0000, 0x00ff00]);
  assert.equal(pools.mesh.count, 2);
  const at = new THREE.Matrix4();
  pools.mesh.getMatrixAt(1, at);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(at).toArray().map(v => +v.toFixed(3)), [5, 0.05, 6]);
  const holo = hologram({ position: [10, 13.5, 0], size: [4, 7] });
  holo.update(2, { position: new THREE.Vector3(10, 1, 20) });
  assert.ok(Math.abs(holo.object.rotation.y) < 1e-9, 'a viewer on +z sees it face-on');
  holo.update(2, { position: new THREE.Vector3(30, 1, 0) });
  assert.ok(Math.abs(holo.object.rotation.y - Math.PI / 2) < 1e-9, 'it turns to face a viewer on +x');
  assert.equal(holo.object.material.uniforms.uTime.value, 2);
});

test('wallAhead returns the last clear point before a wall, or null when nothing is in reach', () => {
  const hit = wallAhead(t.clearance, 0, 0, 0, 1, 4, 5, 8);
  assert.ok(hit && Math.abs(hit.distance - 3) < 0.3, `3 m to the wall: ${hit?.distance}`);
  assert.equal(wallAhead(t.clearance, 0, 0, 1, 0, 4, 5, 8), null, 'the street runs on');
});
