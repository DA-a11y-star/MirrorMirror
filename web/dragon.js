import * as THREE from 'three';

// A flying Chinese dragon that circles over a set. Decoration only: it is built from primitives (flat-shaded, like the
// rest of the world), lives in the scene and never in `blocks`, and is a pure function of the clock, so both laptops
// show it in about the same place without sending anything.
//
// The flight path is a closed loop whose radius and height swell and ebb, sampled by arc length: segment i sits exactly
// i * spacing behind the head along the path, so the body never stretches. A wave runs down the body from head to
// tail (sideways and up and down), which is what makes it swim through the air instead of sliding along a rail.

export const DRAGON_DEFAULTS = {
  center: [0, 0],        // x, z the loop circles around
  radius: [22, 34],      // m: nearest and farthest the loop gets from the centre
  height: [12, 18],      // m: lowest and highest the centre of the body flies
  speed: 8,              // m/s along the path
  tempo: 1,              // clock speed of the whole animation: flight, body wave, whiskers and legs. 0.5 = half speed
  size: 1,               // scales the thickness (the length follows `segments` * `spacing`)
  segments: 46,
  spacing: 0.9,          // m between body segments along the path
  wave: { side: 1.1, up: 0.9, length: 9, speed: 2.4 }, // amplitude m (at its fullest), wavelength m, cycles-ish per s
};

const SAMPLES = 720;
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const TWO_PI = Math.PI * 2;

// The closed loop, as a table of points with their cumulative arc length, so a position can be asked for by distance.
export function makePath(cfg = {}) {
  const c = { ...DRAGON_DEFAULTS, ...cfg };
  const [r0, r1] = c.radius;
  const [h0, h1] = c.height;
  const rMid = (r0 + r1) / 2, rAmp = (r1 - r0) / 2, hMid = (h0 + h1) / 2, hAmp = (h1 - h0) / 2;
  const points = [];
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / SAMPLES) * TWO_PI;
    const r = rMid + rAmp * Math.sin(2 * a + 0.6);           // two swoops in and out per lap
    const h = hMid + hAmp * Math.sin(3 * a + 1.1);           // three rises and dips per lap
    points.push(new THREE.Vector3(c.center[0] + r * Math.cos(a), h, c.center[1] + r * Math.sin(a)));
  }
  const cumulative = [0];
  for (let i = 1; i <= SAMPLES; i++) cumulative.push(cumulative[i - 1] + points[i % SAMPLES].distanceTo(points[i - 1]));
  return { points, cumulative, length: cumulative[SAMPLES], cfg: c };
}

// Writes the point `s` metres along the loop into `out`.
export function pointAt(path, s, out = new THREE.Vector3()) {
  const { points, cumulative, length } = path;
  s = ((s % length) + length) % length;
  let lo = 0, hi = SAMPLES;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cumulative[mid] <= s) lo = mid; else hi = mid; }
  const span = cumulative[lo + 1] - cumulative[lo] || 1;
  return out.lerpVectors(points[lo], points[(lo + 1) % SAMPLES], (s - cumulative[lo]) / span);
}

// How wide the wave is at segment i of n: calm at the head, fullest through the body, easing off at the tail.
const envelope = (i, n) => 0.25 + 0.75 * Math.sin(Math.PI * Math.min(1, (i + 2) / (n * 0.9)));

// The `segments` body points at `time` (seconds, any clock both laptops share): index 0 is the head. Writes into `out`
// (an array of Vector3, created if missing) and returns it. Each segment is placed exactly `spacing` behind the one
// ahead of it, searching back along the path for the spot where the waved point lands that far away; just stepping a
// fixed distance along the path would stretch the body wherever the wave is steep.
export function dragonPose(path, time, out = []) {
  const { segments, spacing, speed, tempo } = path.cfg;
  time *= tempo; // one clock for everything, so a slower dragon flies, undulates and flutters slower together
  const tmp = new THREE.Vector3();
  let s = time * speed;
  out[0] ??= new THREE.Vector3();
  waved(path, 0, s, time, out[0]);
  for (let i = 1; i < segments; i++) {
    let far = s - 2 * spacing, near = s - 0.15 * spacing;
    for (let n = 0; n < 14; n++) {
      const mid = (far + near) / 2;
      if (waved(path, i, mid, time, tmp).distanceTo(out[i - 1]) > spacing) far = mid; else near = mid;
    }
    s = (far + near) / 2;
    out[i] ??= new THREE.Vector3();
    waved(path, i, s, time, out[i]);
  }
  return out;
}

// Segment i if it sat `s` metres along the path at `time`: the path point, pushed sideways and up by the travelling wave.
const _here = new THREE.Vector3(), _ahead = new THREE.Vector3(), _tangent = new THREE.Vector3(), _side = new THREE.Vector3();
function waved(path, i, s, time, out) {
  const { segments, spacing, wave } = path.cfg;
  pointAt(path, s, _here);
  pointAt(path, s + 0.5, _ahead);
  _tangent.subVectors(_ahead, _here).normalize();
  _side.set(-_tangent.z, 0, _tangent.x).normalize();
  const phase = (TWO_PI / wave.length) * (i * spacing) - wave.speed * time;
  const k = envelope(i, segments);
  return out.copy(_here).addScaledVector(_side, wave.side * k * Math.sin(phase)).addScaledVector(UP, wave.up * k * Math.cos(phase));
}

// Body thickness at segment i (m radius): a thin neck, the thickest part behind the shoulders, then a long taper.
export function radiusAt(i, n, size = 1) {
  const u = i / (n - 1);
  const swell = u < 0.12 ? 0.55 + (u / 0.12) * 0.45 : 1 - 0.85 * ((u - 0.12) / 0.88) ** 0.9;
  return 1.1 * size * Math.max(0.12, swell);
}

const RED = new THREE.Color(0xc4302b), DEEP_RED = new THREE.Color(0x9c2220), GOLD = new THREE.Color(0xe8b923);

export class Dragon {
  constructor(scene, config = {}) {
    this.path = makePath(config);
    const { segments, size } = this.path.cfg;
    this.size = size;
    this.root = new THREE.Group();
    this.root.name = 'dragon';
    this.root.frustumCulled = false;
    this.pose = Array.from({ length: segments }, () => new THREE.Vector3());

    this.materials = [];
    const flat = color => {
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, flatShading: true });
      this.materials.push(material);
      return material;
    };
    const bodyMaterial = flat(0xffffff); // tinted per segment through instance colors
    bodyMaterial.emissive.set(0x43140a); bodyMaterial.emissiveIntensity = 0.3; // warm separation against the twilight sky
    const gold = flat(0xe8b923);
    gold.emissive.set(0x5a4208);
    const bone = flat(0xf3ead2);
    const eye = new THREE.MeshStandardMaterial({ color: 0xfff2a0, emissive: 0xffd24a, emissiveIntensity: 1.4, flatShading: true });
    this.materials.push(eye);
    const red = flat(RED), deepRed = flat(DEEP_RED);

    this.body = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 9, 6), bodyMaterial, segments);
    this.spines = new THREE.InstancedMesh(new THREE.ConeGeometry(0.5, 1, 4), gold, segments);
    for (const mesh of [this.body, this.spines]) { mesh.frustumCulled = false; this.root.add(mesh); }
    const color = new THREE.Color();
    for (let i = 0; i < segments; i++) {
      // Red scales with a gold band every fifth segment, and a darker belly-red toward the tail.
      color.copy(i % 5 === 4 ? GOLD : RED).lerp(DEEP_RED, (i / segments) * 0.6);
      this.body.setColorAt(i, color);
    }

    // Head, facing +z in its own frame (the same way every body segment is built).
    this.head = new THREE.Group();
    const part = (geometry, material, position, scale, rotation = [0, 0, 0]) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.scale.set(...scale);
      mesh.rotation.set(...rotation);
      this.head.add(mesh);
      return mesh;
    };
    const sphere = new THREE.SphereGeometry(1, 9, 6), box = new THREE.BoxGeometry(1, 1, 1), cone = new THREE.ConeGeometry(0.5, 1, 5);
    const k = size;
    part(sphere, red, [0, 0, 0], [0.95 * k, 0.8 * k, 1.1 * k]);                                          // skull
    part(box, red, [0, -0.12 * k, 1.25 * k], [0.8 * k, 0.5 * k, 1.5 * k]);                         // snout
    part(box, deepRed, [0, -0.5 * k, 1.1 * k], [0.7 * k, 0.22 * k, 1.3 * k]);                     // jaw
    part(sphere, bone, [0.28 * k, -0.4 * k, 1.95 * k], [0.09 * k, 0.12 * k, 0.09 * k]);                  // fangs
    part(sphere, bone, [-0.28 * k, -0.4 * k, 1.95 * k], [0.09 * k, 0.12 * k, 0.09 * k]);
    for (const x of [-1, 1]) {
      part(sphere, eye, [x * 0.5 * k, 0.28 * k, 0.75 * k], [0.17 * k, 0.17 * k, 0.17 * k]);              // eyes
      part(cone, bone, [x * 0.38 * k, 0.78 * k, -0.2 * k], [0.28 * k, 1.5 * k, 0.28 * k], [-0.9, 0, x * -0.35]); // horns
      part(cone, gold, [x * 0.62 * k, -0.05 * k, -0.5 * k], [0.2 * k, 0.9 * k, 0.2 * k], [-1.3, 0, x * -0.9]);   // ear fins
    }
    for (let m = 0; m < 5; m++) { // mane running back from the skull
      part(cone, m % 2 ? gold : deepRed, [0, (0.7 - m * 0.04) * k, (-0.5 - m * 0.55) * k], [0.5 * k, 1.1 * k, 0.5 * k], [-2.3, 0, 0]);
    }
    // Long whiskers that trail and flutter.
    this.whiskers = [-1, 1].map(x => {
      const pivot = new THREE.Group();
      pivot.position.set(x * 0.35 * k, -0.05 * k, 2.0 * k);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * k, 0.012 * k, 3.4 * k, 5), gold);
      mesh.position.y = -1.7 * k; // hangs down from the pivot; the pivot is tipped back in update()
      pivot.add(mesh);
      pivot.userData.side = x;
      this.head.add(pivot);
      return pivot;
    });
    this.root.add(this.head);

    // Four short legs with claws, hung from two pairs of segments.
    this.legs = [];
    for (const [segment, side] of [[9, -1], [9, 1], [27, -1], [27, 1]]) {
      const leg = new THREE.Group();
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.17 * k, 0.1 * k, 1.5 * k, 5), red);
      upper.position.y = -0.75 * k;
      leg.add(upper);
      for (let c = -1; c <= 1; c++) {
        const claw = new THREE.Mesh(cone, bone);
        claw.scale.set(0.12 * k, 0.5 * k, 0.12 * k);
        claw.position.set(c * 0.14 * k, -1.62 * k, 0.1 * k);
        claw.rotation.x = Math.PI;
        leg.add(claw);
      }
      leg.userData = { segment, side };
      this.legs.push(leg);
      this.root.add(leg);
    }

    // A gold tuft at the end of the tail.
    this.tuft = [0, 1, 2].map(n => {
      const mesh = new THREE.Mesh(cone, gold);
      mesh.scale.set(0.35 * k, 2.2 * k, 0.35 * k);
      this.root.add(mesh);
      return mesh;
    });

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._p = new THREE.Vector3();
    scene.add(this.root);
    this.update(Date.now() / 1000);
  }

  // Puts the dragon where it should be at `time` seconds. Pass the wall clock so every laptop agrees.
  update(time = Date.now() / 1000) {
    const { segments, tempo } = this.path.cfg;
    const pose = dragonPose(this.path, time, this.pose); // scales the clock by `tempo` itself
    const t = time * tempo; // the head tilt, whiskers and legs run on that same slower clock
    const { _m: m, _q: q, _s: s, _f: f, _r: r, _u: u, _p: p } = this;
    const basis = (i, out) => { // forward (toward the head), then a level right and an up that follow the body
      f.subVectors(pose[Math.max(0, i - 1)], pose[Math.min(segments - 1, i + 1)]).normalize();
      r.crossVectors(UP, f).normalize();
      u.crossVectors(f, r).normalize();
      out.makeBasis(r, u, f);
      return out;
    };
    for (let i = 0; i < segments; i++) {
      const radius = radiusAt(i, segments, this.size);
      basis(i, m);
      q.setFromRotationMatrix(m);
      this.body.setMatrixAt(i, m.compose(pose[i], q, s.set(radius, radius * 0.92, this.path.cfg.spacing * 0.85)));
      // A gold spine fin on top of every other segment, leaning back.
      if (i % 2 === 0 && i > 2) {
        basis(i, m);
        q.setFromRotationMatrix(m);
        p.copy(pose[i]).addScaledVector(u, radius * 0.95);
        const fin = radius * 0.9;
        this.spines.setMatrixAt(i, m.compose(p, q.multiply(this._tilt(-0.5)), s.set(fin * 0.55, fin, fin * 0.55)));
      } else {
        this.spines.setMatrixAt(i, m.makeScale(0, 0, 0));
      }
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.spines.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;

    // Head: faces along the path and banks into the turn, with a little nod.
    basis(0, m);
    this.head.position.copy(pose[0]).addScaledVector(f, this.size * 0.6);
    this.head.quaternion.setFromRotationMatrix(m).multiply(this._tilt(0.12 * Math.sin(t * 2.4)));
    for (const whisker of this.whiskers) {
      // Tipped back until it trails behind the head (x), swept out to the side (z), and fluttering in the wind.
      const flutter = Math.sin(t * 5 + whisker.userData.side * 1.7);
      whisker.rotation.set(1.2 + 0.18 * flutter, 0, whisker.userData.side * (0.45 + 0.12 * flutter));
    }

    for (const leg of this.legs) { // legs trail and swing as the body undulates
      const { segment, side } = leg.userData;
      basis(segment, m);
      q.setFromRotationMatrix(m);
      leg.position.copy(pose[segment]).addScaledVector(r, side * radiusAt(segment, segments, this.size) * 0.85)
        .addScaledVector(u, -radiusAt(segment, segments, this.size) * 0.5);
      leg.quaternion.copy(q).multiply(this._tilt(-0.55 + 0.35 * Math.sin(t * 3 + segment)));
    }

    const last = segments - 1;
    basis(last, m);
    q.setFromRotationMatrix(m);
    this.tuft.forEach((mesh, n) => {
      mesh.position.copy(pose[last]).addScaledVector(f, -0.8 - n * 0.2).addScaledVector(r, (n - 1) * 0.35);
      mesh.quaternion.copy(q).multiply(this._tilt(-1.9 - 0.12 * Math.sin(t * 4 + n)));
    });
  }

  _tilt(angle) { // a rotation about the local x axis (nods the head, sweeps legs and fins)
    return (this._tiltQ ??= new THREE.Quaternion()).setFromAxisAngle(X_AXIS, angle);
  }

  dispose() {
    this.root.traverse(node => { if (node.geometry) node.geometry.dispose(); });
    for (const material of this.materials) material.dispose();
    this.root.removeFromParent();
  }
}
