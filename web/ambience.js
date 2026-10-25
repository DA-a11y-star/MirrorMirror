import * as THREE from 'three';
import { random } from './set-layout.js';
import { sampleField } from './roads.js';

// Life for a set: lanterns, sky lanterns, fireworks, petals, rain, steam, neon signs, glow pools, holograms. Everything is
// either instanced or a `Points`/`LineSegments` object whose motion is computed in its vertex shader from the clock, so
// the CPU does almost nothing per frame and none of it adds a light or a shadow. The planners are pure and seeded (same
// input, same layout on every laptop) and test without a browser; the shaders can't, so they are kept small.

// --- particles ---------------------------------------------------------------------------------------------------

// A soft round glow, as data (no canvas, so it also builds in Node).
export function glowTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.min(1, Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2);
      const a = (1 - r) ** 2;
      data.set([255, 255, 255, Math.round(a * 255)], (y * size + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
let sharedGlow = null;
const glow = () => {
  if (!sharedGlow) { sharedGlow = glowTexture(); sharedGlow.userData.shared = true; }
  return sharedGlow;
};

// Pixels per metre at one metre, for sizing points from the camera's field of view (without a window it assumes 800 px tall).
export function pixelScale(camera) {
  const height = (globalThis.innerHeight ?? 800) * Math.min(globalThis.devicePixelRatio ?? 1, 2);
  return height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

const POINT_VERTEX = (declare, motion) => `
uniform float uTime; uniform float uScale; uniform float uSize; uniform vec3 uCamera;
${declare}
attribute vec4 aSeed; attribute vec3 aColor;
varying vec3 vColor; varying float vAlpha;
void main() {
  vec3 p = position; vec3 col = aColor; float alpha = 1.0; float s = 1.0;
  ${motion}
  vColor = col; vAlpha = alpha;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * s * uScale / max(-mv.z, 0.1), 1.0, 96.0);
}`;
const POINT_FRAGMENT = `
uniform sampler2D uMap; varying vec3 vColor; varying float vAlpha;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
}`;

// A `Points` object whose motion is `motion` (GLSL that sets p, col, alpha and s; see POINT_VERTEX). `attributes` are
// {position, seed (4 per point), color (3 per point)} plus any extra named ones. -> {object, update(seconds, camera)}
export function particles({ count, position, seed, color, extra = {}, declare = '', motion = '', uniforms = {}, size = 1, blending = THREE.AdditiveBlending }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  for (const [name, [array, itemSize]] of Object.entries(extra)) geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  const material = new THREE.ShaderMaterial({
    vertexShader: POINT_VERTEX(declare, motion), fragmentShader: POINT_FRAGMENT,
    uniforms: { uTime: { value: 0 }, uScale: { value: 800 }, uSize: { value: size }, uCamera: { value: new THREE.Vector3() }, uMap: { value: glow() }, ...uniforms },
    transparent: true, depthWrite: false, blending, fog: false,
  });
  const object = new THREE.Points(geometry, material);
  object.frustumCulled = false; // its points move in the shader, so the geometry's bounds mean nothing
  object.userData.scenery = true;
  object.userData.count = count;
  return {
    object,
    update(seconds, camera) {
      material.uniforms.uTime.value = seconds;
      if (camera) { material.uniforms.uCamera.value.copy(camera.position); material.uniforms.uScale.value = pixelScale(camera); }
    },
  };
}

const fill = (count, size, make) => {
  const out = new Float32Array(count * size);
  for (let i = 0; i < count; i++) out.set(make(i), i * size);
  return out;
};
const mix = (a, b, t) => a + (b - a) * t;

// Warm glowing lanterns drifting up from a ring around `center` ([x, z]) and looping: `count` of them, `radius` ([min, max])
// from the centre, rising up to `height` metres at about 0.6-1.0 m/s.
export function skyLanterns({ count = 60, center = [0, 0], radius = [8, 48], height = 45, clearance = null, rand }) {
  const position = fill(count, 3, () => {
    let x, z;
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = rand() * Math.PI * 2, r = mix(radius[0], radius[1], Math.sqrt(rand()));
      x = center[0] + Math.cos(a) * r; z = center[1] + Math.sin(a) * r;
      if (!clearance || clearance.clear(x, z, 2.5, 0, height)) return [x, 0, z];
    }
    // A dense town may have no clear courtyard here: start above its roofs, never inside one.
    return [x, 12, z];
  });
  const seed = fill(count, 4, () => [rand(), mix(0.6, 1.0, rand()), rand(), rand()]);
  const color = fill(count, 3, () => [1, mix(0.45, 0.7, rand()), mix(0.12, 0.3, rand())]);
  const effect = particles({
    count, position, seed, color, size: 1.1, uniforms: { uHeight: { value: height } }, declare: 'uniform float uHeight;',
    motion: `
      float life = mod(aSeed.z + uTime * aSeed.y / uHeight, 1.0);
       p.y += life * uHeight;
      p.x += sin(uTime * 0.35 + aSeed.x * 6.283) * 2.0;
      p.z += cos(uTime * 0.3 + aSeed.w * 6.283) * 2.0;
      alpha = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.7, 1.0, life));
      s = 1.0 + 0.1 * sin(uTime * 2.0 + aSeed.x * 30.0);`,
  });
  // Paper silhouettes accompany the distant glow; points alone looked like floating fireflies up close.
  const geometry = new THREE.BoxGeometry(0.42, 0.65, 0.42);
  geometry.setAttribute('aFlight', new THREE.InstancedBufferAttribute(seed, 4));
  geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(position, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: effect.object.material.uniforms.uTime, uHeight: { value: height } },
    vertexShader: `uniform float uTime; uniform float uHeight; attribute vec4 aFlight; attribute vec3 aStart;
      varying float vLife; varying float vShade;
      void main() {
        vLife = mod(aFlight.z + uTime * aFlight.y / uHeight, 1.0);
        vec3 p = aStart; p.y += vLife * uHeight;
        p.x += sin(uTime * 0.35 + aFlight.x * 6.283) * 2.0;
        p.z += cos(uTime * 0.3 + aFlight.w * 6.283) * 2.0;
        vShade = 0.75 + normal.y * 0.18 + normal.z * 0.12;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p + position, 1.0);
      }`,
    fragmentShader: `varying float vLife; varying float vShade; void main() {
      float a = smoothstep(0.0,0.08,vLife) * (1.0-smoothstep(0.7,1.0,vLife));
      gl_FragColor = vec4(vec3(1.0,0.52,0.19) * vShade, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
    transparent: true, depthWrite: false, toneMapped: false,
  });
  const paper = new THREE.InstancedMesh(geometry, material, count);
  paper.frustumCulled = false; paper.userData.scenery = true;
  const group = new THREE.Group(); group.name = 'sky-lanterns'; group.add(paper, effect.object);
  return { ...effect, group };
}

// Falling blossom or confetti in a box of `radius` x `height` that follows the camera (wrapping, so some is always near
// you and the cost never grows). `colors` are RGB triples in 0-1.
export function petals({ count = 300, radius = 28, height = 22, colors = [[1, 0.72, 0.8], [1, 0.9, 0.92], [1, 0.55, 0.65]], rand }) {
  const position = fill(count, 3, () => [rand(), rand(), rand()]);
  const seed = fill(count, 4, () => [rand(), rand(), rand(), rand()]);
  const color = fill(count, 3, () => colors[Math.floor(rand() * colors.length)]);
  return particles({
    count, position, seed, color, size: 0.2, blending: THREE.NormalBlending,
    uniforms: { uRadius: { value: radius }, uHeight: { value: height } }, declare: 'uniform float uRadius; uniform float uHeight;',
    motion: `
      float y = mod(position.y * uHeight - uTime * (0.6 + aSeed.y * 0.8), uHeight);
      vec2 sway = vec2(sin(uTime * 0.5 + aSeed.x * 6.283), cos(uTime * 0.4 + aSeed.z * 6.283)) * 1.5 + uTime * vec2(0.3, 0.1);
      vec2 xz = mod(position.xz * 2.0 * uRadius + sway - uCamera.xz, 2.0 * uRadius) - uRadius;
      p = vec3(uCamera.x + xz.x, y, uCamera.z + xz.y);
      alpha = (1.0 - smoothstep(0.7 * uRadius, uRadius, length(xz))) * smoothstep(0.0, 2.0, y) * 0.9;
      s = 0.7 + aSeed.w * 0.8;`,
  });
}

// Steam plumes rising from `vents` ([[x, z], ...]), `per` puffs each, up to `height` metres.
export function steam({ vents, per = 20, height = 7, rand }) {
  const count = vents.length * per;
  const position = fill(count, 3, i => [vents[Math.floor(i / per)][0], 0.1, vents[Math.floor(i / per)][1]]);
  const seed = fill(count, 4, () => [rand(), mix(0.5, 1.1, rand()), rand(), rand()]);
  const color = fill(count, 3, () => [0.62, 0.72, 0.85]);
  return particles({
    count, position, seed, color, size: 1.6, blending: THREE.NormalBlending,
    uniforms: { uHeight: { value: height } }, declare: 'uniform float uHeight;',
    motion: `
      float life = mod(aSeed.z + uTime * aSeed.y / uHeight * 1.4, 1.0);
      p.y += life * uHeight;
      p.x += sin(uTime * 0.6 + aSeed.x * 6.283) * life * 1.2 + (aSeed.w - 0.5) * life * 1.5;
      p.z += cos(uTime * 0.5 + aSeed.w * 6.283) * life * 1.2;
      alpha = smoothstep(0.0, 0.12, life) * (1.0 - life) * 0.32;
      s = 0.6 + life * 2.2;`,
  });
}

// Static glowing halos (a soft additive point each) at `points` ([[x, y, z, size], ...]) in `colors`, flickering gently.
export function halos({ points, colors, rand, flicker = 1.5 }) {
  const count = points.length;
  const position = fill(count, 3, i => [points[i][0], points[i][1], points[i][2]]);
  const seed = fill(count, 4, () => [mix(0.5, flicker * 3, rand()), rand(), rand(), rand()]);
  const color = fill(count, 3, i => colors[i % colors.length]);
  const sizes = fill(count, 1, i => [points[i][3] ?? 2]);
  return particles({
    count, position, seed, color, extra: { aSize: [sizes, 1] }, size: 1, declare: 'attribute float aSize;',
    motion: `
      alpha = 0.5 + 0.2 * sin(uTime * aSeed.x + aSeed.y * 6.283);
      s = aSize;`,
  });
}

// --- fireworks ---------------------------------------------------------------------------------------------------

// One burst of the show: slot `slot` on lap `cycle`. Pure: the same numbers give the same burst, so every laptop with the
// same clock sees the same sky. -> {center: [x, y, z], color: [r, g, b]}
export function fireworkBurst(slot, cycle, { center = [0, 0], ring = [25, 60], heights = [26, 44] } = {}) {
  const rand = random(((slot + 1) * 73856093 ^ (cycle + 1000) * 19349663 ^ 0x9e3779b9) >>> 0);
  const angle = rand() * Math.PI * 2, r = mix(ring[0], ring[1], rand());
  const hue = rand(), c = new THREE.Color().setHSL(hue, 1, 0.58);
  return { center: [center[0] + Math.cos(angle) * r, mix(heights[0], heights[1], rand()), center[1] + Math.sin(angle) * r], color: [c.r, c.g, c.b] };
}

// Where every slot of the show is at `time` seconds (a shared clock): slot i fires every `period` s, offset by i / slots of
// a period, and lasts `life` s. -> [{age (seconds since it went off, -1 when dark), burst}]
export function fireworkShow(time, { slots = 6, period = 7, life = 3.2, ...place } = {}) {
  return Array.from({ length: slots }, (_, slot) => {
    const cycle = time / period + slot / slots, lap = Math.floor(cycle), age = (cycle - lap) * period;
    return { age: age < life ? age : -1, burst: fireworkBurst(slot, lap, place) };
  });
}

// The show as one `Points` object: `slots` bursts of `per` sparks each. Its schedule runs off the wall clock, not `seconds`.
export function fireworks({ slots = 6, per = 80, period = 7, life = 3.2, center = [0, 0], ring = [25, 60], heights = [26, 44], rand }) {
  const count = slots * per;
  const dir = fill(count, 3, () => {
    const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), z, r * Math.sin(a)];
  });
  const seed = fill(count, 4, i => [Math.floor(i / per), mix(0.55, 1, rand()), rand(), rand()]);
  const burst = Array.from({ length: slots }, () => new THREE.Vector4(0, -999, 0, -1));
  const tint = Array.from({ length: slots }, () => new THREE.Vector3(1, 1, 1));
  const effect = particles({
    count, position: new Float32Array(count * 3), seed, color: new Float32Array(count * 3), extra: { aDir: [dir, 3] }, size: 1.3,
    uniforms: { uBurst: { value: burst }, uTint: { value: tint }, uLife: { value: life } },
    declare: `uniform vec4 uBurst[${slots}]; uniform vec3 uTint[${slots}]; uniform float uLife; attribute vec3 aDir;`,
    motion: `
      int slot = int(aSeed.x + 0.5);
      vec4 b = uBurst[slot];
      if (b.w < 0.0) { alpha = 0.0; p = vec3(0.0, -999.0, 0.0); }
      else {
        float t = b.w;
        float reach = 9.0 * aSeed.y * (1.0 - exp(-2.0 * t)) / 2.0;
        p = b.xyz + aDir * reach;
        p.y -= 2.2 * t * t;
        float k = t / uLife;
        alpha = (1.0 - k) * (0.65 + 0.35 * sin(uTime * 18.0 + aSeed.z * 40.0));
        s = 1.0 + 1.5 * exp(-6.0 * t);
        col = uTint[slot] * (0.7 + 0.3 * aSeed.w);
      }`,
  });
  return {
    object: effect.object,
    update(seconds, camera) {
      effect.update(seconds, camera);
      fireworkShow(Date.now() / 1000, { slots, period, life, center, ring, heights }).forEach(({ age, burst: b }, i) => {
        burst[i].set(b.center[0], b.center[1], b.center[2], age);
        tint[i].set(...b.color);
      });
    },
  };
}

// --- rain --------------------------------------------------------------------------------------------------------

// Thin streaks of rain in a box of `radius` x `height` that follows the camera (wrapping). Two vertices per streak.
export function rain({ count = 1500, radius = 24, height = 28, length = 0.9, color = [0.62, 0.74, 0.95], clearance = null, rand }) {
  const position = new Float32Array(count * 2 * 3), seed = new Float32Array(count * 2 * 4), end = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const base = [rand(), rand(), rand()], s = [rand(), rand(), rand(), rand()];
    for (let k = 0; k < 2; k++) { position.set(base, (i * 2 + k) * 3); seed.set(s, (i * 2 + k) * 4); end[i * 2 + k] = k; }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geometry.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const roof = new THREE.DataTexture(clearance ? Float32Array.from(clearance.bits, bits => bits ? (32 - Math.clz32(bits)) * clearance.layer : -100) : new Float32Array([-100]), clearance?.w ?? 1, clearance?.d ?? 1, THREE.RedFormat, THREE.FloatType);
  roof.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCamera: { value: new THREE.Vector3() }, uRadius: { value: radius }, uHeight: { value: height }, uLength: { value: length }, uColor: { value: new THREE.Vector3(...color) }, uRoof: { value: roof }, uBounds: { value: clearance ? new THREE.Vector4(clearance.x0, clearance.z0, clearance.w * clearance.cell, clearance.d * clearance.cell) : new THREE.Vector4(0, 0, 1, 1) } },
    vertexShader: `
       uniform float uTime; uniform vec3 uCamera; uniform float uRadius; uniform float uHeight; uniform float uLength; uniform sampler2D uRoof; uniform vec4 uBounds;
      attribute vec4 aSeed; attribute float aEnd; varying float vAlpha;
      void main() {
        float speed = 14.0 + aSeed.y * 8.0;
        float y = mod(position.y * uHeight - uTime * speed, uHeight);
        vec2 xz = mod(position.xz * 2.0 * uRadius - uCamera.xz, 2.0 * uRadius) - uRadius;
         vec3 p = vec3(uCamera.x + xz.x, y + max(0.0, uCamera.y - 3.0), uCamera.z + xz.y);
        p += vec3(0.12, 1.0, 0.04) * uLength * aEnd;
         vAlpha = (1.0 - smoothstep(0.6 * uRadius, uRadius, length(xz))) * (0.12 + 0.16 * aSeed.w) * (1.0 - aEnd * 0.6);
         vec2 uv = (p.xz - uBounds.xy) / uBounds.zw;
         float inside = step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0);
         float roof = texture2D(uRoof, clamp(uv,0.0,1.0)).r;
         vAlpha *= mix(1.0, step(roof + 0.2, p.y), inside);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: 'uniform vec3 uColor; varying float vAlpha; void main() { gl_FragColor = vec4(uColor, vAlpha); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  material.userData.ownedTextures = [roof];
  const object = new THREE.LineSegments(geometry, material);
  object.frustumCulled = false;
  object.userData.scenery = true;
  return { object, update(seconds, camera) { material.uniforms.uTime.value = seconds; if (camera) material.uniforms.uCamera.value.copy(camera.position); } };
}

// --- planning on the city's map ----------------------------------------------------------------------------------

// Ground levels that call every cell inside `box` (a Box3 of the model) road level and everything outside it no ground:
// for a model with no ground of its own, so roadField/roadSkeleton can find the open streets between its buildings.
export function openGroundLevels(clearance, box) {
  const { x0, z0, w, d, cell } = clearance;
  const levels = new Uint8Array(w * d);
  for (let iz = 0; iz < d; iz++) {
    for (let ix = 0; ix < w; ix++) {
      const x = x0 + (ix + 0.5) * cell, z = z0 + (iz + 0.5) * cell;
      if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z) levels[iz * w + ix] = 1;
    }
  }
  return levels;
}

// How far from (x, z) going along (dx, dz) until something of the model is in the way at heights [y0, y1], up to `reach`
// metres; null if nothing is. The point returned is the last clear one.
export function wallAhead(clearance, x, z, dx, dz, y0, y1, reach, step = 0.25) {
  for (let t = step; t <= reach; t += step) {
    if (!clearance.clear(x + dx * t, z + dz * t, 0.15, y0, y1)) return { distance: t - step, x: x + dx * (t - step), z: z + dz * (t - step) };
  }
  return null;
}

// Strings of lanterns hung across the streets: along the road middle lines (`skeleton`), one every `spacing` ([min, max]) metres
// where a wall stands within `reach` metres on both sides at one of `heights` (tried in order: the first that has walls on
// both sides wins) and the two walls are between `minSpan` and `maxSpan` apart. Each string sags `sag` m in the middle.
// -> [{a: [x, y, z], b: [x, y, z], sag, count}]
export function planLanternStrings({ skeleton, clearance, rand, spacing = [7, 11], reach = 8, heights = [4.4, 3.8, 3.2], minSpan = 3, maxSpan = 9.5, sag = 0.5, minLantern = 1.1 }) {
  const candidates = skeleton.filter(p => p.line >= 0.85);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const strings = [];
  for (const p of candidates) {
    const wanted = mix(spacing[0], spacing[1], rand());
    if (strings.some(s => Math.hypot((s.a[0] + s.b[0]) / 2 - p.x, (s.a[2] + s.b[2]) / 2 - p.z) < wanted)) continue;
    const nx = -p.tz, nz = p.tx;
    for (const height of heights) {
      const left = wallAhead(clearance, p.x, p.z, nx, nz, height - 0.5, height + 0.5, reach);
      const right = wallAhead(clearance, p.x, p.z, -nx, -nz, height - 0.5, height + 0.5, reach);
      if (!left || !right) continue;
      const span = left.distance + right.distance;
      if (span < minSpan || span > maxSpan) continue;
      // The map is a little conservative (cells, and a probe radius), so the last clear point is up to ~0.3 m short of the wall.
      strings.push({ a: [left.x + nx * 0.28, height, left.z + nz * 0.28], b: [right.x - nx * 0.28, height, right.z - nz * 0.28], sag, count: Math.max(3, Math.round(span / minLantern)) });
      break;
    }
  }
  return strings;
}

// The lantern positions along the strings (a parabola sagging `sag` m), each hanging 0.45 m below its rope.
// -> [{x, y, z, phase, size, color: [r, g, b]}]
export const LANTERN_COLORS = [[0.95, 0.12, 0.08], [1, 0.32, 0.1], [1, 0.55, 0.12], [0.9, 0.12, 0.3]];
export function lanternsOn(strings, rand) {
  const out = [];
  for (const s of strings) {
    for (let k = 0; k < s.count; k++) {
      const t = (k + 0.5) / s.count;
      out.push({
        x: mix(s.a[0], s.b[0], t), z: mix(s.a[2], s.b[2], t), y: mix(s.a[1], s.b[1], t) - s.sag * 4 * t * (1 - t) - 0.45,
        phase: rand() * Math.PI * 2, size: mix(0.55, 0.7, rand()), color: LANTERN_COLORS[Math.floor(rand() * LANTERN_COLORS.length)],
      });
    }
  }
  return out;
}

// Real supports, not occupancy-map "walls" (that map fills the empty volume beneath roofs). Both posts and the
// crossbeam must fit in open air. The generated arch and rope share these exact endpoints; no guessed attachment.
export function planFestivalArches({ skeleton, clearance, around = [0, 0], count = 8, gap = 12, height = 4.6 }) {
  const ordered = skeleton.filter(p => p.line >= 0.85).slice().sort((a, b) =>
    Math.hypot(a.x - around[0], a.z - around[1]) - Math.hypot(b.x - around[0], b.z - around[1]));
  const out = [];
  for (const p of ordered) {
    if (out.length >= count) break;
    if (Math.hypot(p.x - around[0], p.z - around[1]) < 6 || out.some(s => Math.hypot(s.x - p.x, s.z - p.z) < gap)) continue;
    const half = Math.min(3.2, p.half - 0.45);
    if (half < 1.6) continue;
    const nx = -p.tz, nz = p.tx;
    const a = [p.x + nx * half, height, p.z + nz * half], b = [p.x - nx * half, height, p.z - nz * half];
    if (![a, b].every(v => clearance.clear(v[0], v[2], 0.32, 0.1, height + 0.65))) continue;
    let clear = true;
    for (let t = 0; t <= 1; t += 0.05) {
      if (!clearance.clear(mix(a[0], b[0], t), mix(a[2], b[2], t), 0.35, height - 0.3, height + 0.65)) { clear = false; break; }
    }
    if (clear) out.push({ x: p.x, z: p.z, a, b, sag: 0.3, count: Math.max(3, Math.floor(half * 2 / 0.85)), supported: true });
  }
  return out;
}

export function festivalFrames(strings) {
  const group = new THREE.Group();
  group.name = 'festival-arches';
  const parts = { wood: [], gold: [], roof: [] };
  const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), scale = new THREE.Vector3();
  const add = (kind, x, y, z, w, h, d, yaw = 0, tilt = 0) => {
    q.setFromEuler(new THREE.Euler(0, yaw, tilt, 'YXZ'));
    parts[kind].push(matrix.compose(p.set(x, y, z), q, scale.set(w, h, d)).clone());
  };
  for (const s of strings) {
    const [ax, h, az] = s.a, [bx, , bz] = s.b;
    const span = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(-(bz - az), bx - ax);
    for (const [x, , z] of [s.a, s.b]) {
      add('wood', x, h / 2, z, 0.22, h, 0.22);
      add('gold', x, 0.12, z, 0.4, 0.24, 0.4);
      add('gold', x, h - 0.4, z, 0.26, 0.12, 0.26);
    }
    add('wood', (ax + bx) / 2, h + 0.12, (az + bz) / 2, span + 0.6, 0.24, 0.32, yaw);
    add('gold', (ax + bx) / 2, h + 0.27, (az + bz) / 2, span + 0.7, 0.06, 0.35, yaw);
    add('roof', (ax + bx) / 2, h + 0.4, (az + bz) / 2, span + 1, 0.18, 0.8, yaw);
  }
  for (const [kind, transforms] of Object.entries(parts)) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({
      color: { wood: 0x732b27, gold: 0xc89846, roof: 0x294842 }[kind], roughness: 0.72,
    }), Math.max(1, transforms.length));
    mesh.count = transforms.length;
    transforms.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.computeBoundingSphere();
    mesh.userData.scenery = true;
    group.add(mesh);
  }
  return group;
}

// The lanterns and their ropes. Body: unlit paper that stays vivid (one instanced mesh); gold caps top and bottom (another);
// ropes as line segments; a soft halo under each. They sway a little. `update(seconds)` moves them.
export class LanternStrings {
  constructor(strings, rand) {
    this.strings = strings;
    this.lanterns = lanternsOn(strings, rand);
    const n = this.lanterns.length;
    this.group = new THREE.Group();
    this.group.name = 'lanterns';
    this.body = new THREE.InstancedMesh(new THREE.SphereGeometry(0.4, 14, 10).scale(1, 0.88, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), Math.max(1, n));
    this.caps = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.9, 10),
      new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 0.3, roughness: 0.6 }), Math.max(1, n));
    this.cords = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 4), new THREE.MeshBasicMaterial({ color: 0x876948 }), Math.max(1, n));
    this.cords.count = n;
    this.body.count = this.caps.count = n;
    this.lanterns.forEach((l, i) => this.body.setColorAt(i, new THREE.Color(...l.color)));
    for (const mesh of [this.body, this.caps, this.cords]) { mesh.castShadow = mesh.receiveShadow = false; mesh.frustumCulled = false; mesh.userData.scenery = true; this.group.add(mesh); }
    this.group.add(festivalFrames(strings.filter(s => s.supported)));
    const ropes = [];
    for (const s of strings) {
      const steps = 8;
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps, t1 = (k + 1) / steps;
        for (const t of [t0, t1]) ropes.push(mix(s.a[0], s.b[0], t), mix(s.a[1], s.b[1], t) - s.sag * 4 * t * (1 - t), mix(s.a[2], s.b[2], t));
      }
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ropes), 3));
    this.ropes = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: 0x3a2a1c }));
    this.ropes.userData.scenery = true;
    this.ropes.frustumCulled = false;
    this.group.add(this.ropes);
    this.halo = halos({ points: this.lanterns.map(l => [l.x, l.y, l.z, 2.6 * l.size]), colors: LANTERN_COLORS.map(c => [c[0], c[1] * 0.8, c[2] * 0.6]), rand });
    this.group.add(this.halo.object);
    this.update(0);
  }

  update(seconds, camera) {
    const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), euler = new THREE.Euler(), position = new THREE.Vector3(), scale = new THREE.Vector3();
    const top = new THREE.Vector3(), anchor = new THREE.Vector3(), delta = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    this.lanterns.forEach((l, i) => {
      const swing = Math.sin(seconds * 1.3 + l.phase) * 0.07;
      euler.set(swing * 0.5, 0, swing);
      quaternion.setFromEuler(euler);
      position.set(l.x + swing * 0.3, l.y, l.z);
      matrix.compose(position, quaternion, scale.set(l.size, l.size, l.size));
      this.body.setMatrixAt(i, matrix);
      this.caps.setMatrixAt(i, matrix);
      // A fixed pivot on the rope and a moving attachment at the paper cap: the cord never detaches during sway.
      top.set(0, 0.45 * l.size, 0).applyQuaternion(quaternion).add(position);
      anchor.set(l.x, l.y + 0.45, l.z);
      delta.copy(top).sub(anchor);
      const length = delta.length();
      quaternion.setFromUnitVectors(up, delta.normalize());
      matrix.compose(anchor.add(top).multiplyScalar(0.5), quaternion, scale.set(1, length, 1));
      this.cords.setMatrixAt(i, matrix);
    });
    this.body.instanceMatrix.needsUpdate = this.caps.instanceMatrix.needsUpdate = this.cords.instanceMatrix.needsUpdate = true;
    this.halo.update(seconds, camera);
  }
}

// Standing paper lanterns a person can pick up: where, on the pavement beside a road near `around`, between `radius` ([min,
// max]) metres of it, clear of the avoid discs, at least `gap` metres apart, nearest first. -> [{x, z}]
export function planFloorLanterns({ skeleton, field, clearance, rand, around, radius = [4, 16], count = 8, gap = 3.5, avoid = [] }) {
  const candidates = skeleton.filter(p => p.line >= 0.7 && Math.hypot(p.x - around.x, p.z - around.z) >= radius[0] && Math.hypot(p.x - around.x, p.z - around.z) <= radius[1]);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const out = [];
  for (const p of candidates) {
    if (out.length >= count * 3) break;
    for (const side of rand() < 0.5 ? [1, -1] : [-1, 1]) {
      const off = Math.max(0.6, p.half - 0.8) * side;
      const x = p.x - p.tz * off, z = p.z + p.tx * off;
      if (avoid.some(a => Math.hypot(a.x - x, a.z - z) < a.r)) continue;
      if (out.some(o => Math.hypot(o.x - x, o.z - z) < gap)) continue;
      if (!clearance.clear(x, z, 0.5, 0.1, 1.8) || sampleField(field, field.dist, x, z) < 0.6) continue;
      out.push({ x, z });
      break;
    }
  }
  return out.sort((a, b) => Math.hypot(a.x - around.x, a.z - around.z) - Math.hypot(b.x - around.x, b.z - around.z)).slice(0, count);
}

// A standing paper lantern as a shared, grabbable assembly (like a street lamp): a short stake, a glowing red paper body, gold
// caps and a tassel, 1.7 m tall. Positions are relative to `origin` ([x, z], where the blocks' group sits).
export function lanternSpec(l, index, origin = [0, 0]) {
  const part = (id, shape, size, position, color, emissive) => ({ id, shape, size, position, quaternion: [0, 0, 0, 1], color, ...(emissive ? { emissive } : {}) });
  return {
    version: 1, id: `lantern-${index}`, name: 'paper lantern', position: [l.x - origin[0], 0.02, l.z - origin[1]], quaternion: [0, 0, 0, 1],
    parts: [
      part('base', 'cylinder', [0.5, 0.08, 0.5], [0, 0.04, 0], '#3a2a1c'),
      part('stake', 'cylinder', [0.08, 0.7, 0.08], [0, 0.4, 0], '#3a2a1c'),
      part('body', 'sphere', [0.8, 0.9, 0.8], [0, 1.2, 0], '#d8261f', '#ff4a2a'),
      part('top', 'cylinder', [0.38, 0.07, 0.38], [0, 1.68, 0], '#d9a441', '#6a4a10'),
      part('bottom', 'cylinder', [0.38, 0.07, 0.38], [0, 0.74, 0], '#d9a441', '#6a4a10'),
      part('tassel', 'cone', [0.14, 0.4, 0.14], [0, 0.52, 0], '#d8261f'),
    ],
  };
}

// Where steam rises: `count` points at the edge of the road (0.4 m inside the asphalt's side), at least `gap` metres apart.
// -> [[x, z], ...]
export function planVents({ skeleton, rand, count = 6, gap = 15 }) {
  const candidates = skeleton.filter(p => p.line >= 0.8);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const vents = [];
  for (const p of candidates) {
    if (vents.length >= count) break;
    const side = rand() < 0.5 ? 1 : -1, off = Math.max(0, p.half - 0.4) * side;
    const x = p.x - p.tz * off, z = p.z + p.tx * off;
    if (vents.every(v => Math.hypot(v[0] - x, v[1] - z) >= gap)) vents.push([x, z]);
  }
  return vents;
}

// --- neon signs --------------------------------------------------------------------------------------------------

export const NEON_COLORS = [[1, 0.25, 0.85], [0.2, 0.9, 1], [1, 0.72, 0.25], [0.6, 0.35, 1], [0.4, 1, 0.55]];

// Neon on the building walls beside the roads: from points along the road middle lines look to either side for a wall at
// the sign's height and hang a sign on it, facing the road. Kinds: 'bar' (a horizontal strip), 'strip' (a vertical tube),
// 'panel' (a glyph panel; `pattern` picks its texture). At least `gap` metres between signs. -> [{x, y, z, yaw, w, h, kind,
// pattern, color: [r, g, b]}] (yaw turns a plane facing +z to face the road).
export function planSigns({ skeleton, clearance, rand, count = 60, gap = 5, reach = 12, patterns = 4 }) {
  const candidates = skeleton.filter(p => p.line >= 0.5);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const signs = [];
  for (const p of candidates) {
    if (signs.length >= count) break;
    const kind = ['bar', 'strip', 'panel', 'panel'][Math.floor(rand() * 4)];
    const y = kind === 'strip' ? mix(8, 16, rand()) : mix(5, 18, rand());
    const side = rand() < 0.5 ? 1 : -1;
    const nx = -p.tz * side, nz = p.tx * side;
    const hit = wallAhead(clearance, p.x, p.z, nx, nz, y - 0.4, y + 0.4, reach, 0.1);
    if (!hit || hit.distance < 1.2) continue;
    const x = hit.x + 0.28 * nx, z = hit.z + 0.28 * nz; // the last clear point is up to ~0.3 m short of the wall (the map is conservative): close the gap, just off the wall
    if (signs.some(s => Math.hypot(s.x - x, s.z - z) < gap && Math.abs(s.y - y) < 4)) continue;
    const w = kind === 'bar' ? mix(3, 6, rand()) : kind === 'strip' ? 0.35 : mix(1.6, 2.6, rand());
    const h = kind === 'bar' ? 0.35 : kind === 'strip' ? mix(5, 10, rand()) : mix(2.2, 3.4, rand());
    signs.push({
      x, y, z, yaw: Math.atan2(-nx, -nz), w, h, kind, pattern: Math.floor(rand() * patterns), color: NEON_COLORS[Math.floor(rand() * NEON_COLORS.length)],
    });
  }
  return signs;
}

// The occupancy grid is a planner, not a surface. Attach to real triangles once at load time or discard the sign.
export function anchorSigns(city, signs) {
  city.updateWorldMatrix(true, true);
  const ray = new THREE.Raycaster(), normalMatrix = new THREE.Matrix3();
  return signs.flatMap(sign => {
    const facing = new THREE.Vector3(Math.sin(sign.yaw), 0, Math.cos(sign.yaw));
    const start = new THREE.Vector3(sign.x, sign.y, sign.z).addScaledVector(facing, 2);
    ray.set(start, facing.clone().negate()); ray.far = 5;
    const hit = ray.intersectObject(city, true)[0];
    if (!hit?.face) return [];
    const normal = hit.face.normal.clone().applyNormalMatrix(normalMatrix.getNormalMatrix(hit.object.matrixWorld));
    if (Math.abs(normal.y) > 0.3 || normal.dot(facing) < 0.5) return [];
    const point = hit.point.clone().addScaledVector(normal, 0.045);
    return [{ ...sign, x: point.x, y: point.y, z: point.z, yaw: Math.atan2(normal.x, normal.z) }];
  });
}

// Stylized wet reflections, not a second scene render. A road mask clips them off buildings and pavements.
export class WetStreet {
  constructor(signs, field, { opacity = 0.32 } = {}) {
    const spots = signs.map(s => ({ ...s, px: s.x + Math.sin(s.yaw) * 2, pz: s.z + Math.cos(s.yaw) * 2 }))
      .filter(s => sampleField(field, field.road, s.px, s.pz) > 0.2);
    const data = Uint8Array.from(field.road, v => v > 0 ? 255 : 0);
    const mask = new THREE.DataTexture(data, field.w, field.d, THREE.RedFormat);
    mask.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOpacity: { value: opacity }, uMask: { value: mask }, uBounds: { value: new THREE.Vector4(field.x0, field.z0, field.w * field.cell, field.d * field.cell) } },
      vertexShader: `varying vec2 vUv; varying vec2 vWorld; varying vec3 vTint; varying float vDepth;
        void main() {
          vUv = uv; vTint = instanceColor;
          vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0); vWorld = world.xz;
          vec4 mv = viewMatrix * world; vDepth = -mv.z; gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform float uTime; uniform float uOpacity; uniform sampler2D uMask; uniform vec4 uBounds;
        varying vec2 vUv; varying vec2 vWorld; varying vec3 vTint; varying float vDepth;
        void main() {
          vec2 c = vUv * 2.0 - 1.0;
          float broken = 0.6 + 0.4 * sin(vUv.y * 83.0 + sin(vUv.x * 35.0) * 2.0 + uTime * 0.6);
          float edge = pow(max(0.0, 1.0 - dot(c,c)), 1.8);
          vec2 uv = (vWorld - uBounds.xy) / uBounds.zw;
          float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          float a = edge * broken * uOpacity * texture2D(uMask, uv).r * inside * (1.0 - smoothstep(45.0, 105.0, vDepth));
          gl_FragColor = vec4(vTint, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    material.userData.ownedTextures = [mask];
    this.group = new THREE.Group(); this.group.name = 'wet-street';
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), material, Math.max(1, spots.length));
    mesh.count = spots.length;
    const matrix = new THREE.Matrix4(), q = new THREE.Quaternion();
    spots.forEach((s, i) => {
      matrix.compose(new THREE.Vector3(s.px, 0.045, s.pz), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw), new THREE.Vector3(Math.max(1.4, s.w), 1, Math.min(9, s.h + 4)));
      mesh.setMatrixAt(i, matrix); mesh.setColorAt(i, new THREE.Color(...s.color));
    });
    mesh.computeBoundingSphere(); mesh.userData.scenery = true;
    this.group.add(mesh); this.material = material;
  }
  update(seconds) { this.material.uniforms.uTime.value = seconds; }
}

// `n` square glyph-like textures (white strokes on a transparent ground, a frame round the edge), as RGBA arrays of `size`².
export function signPatterns(rand, n = 4, size = 16) {
  return Array.from({ length: n }, () => {
    const data = new Uint8Array(size * size * 4);
    const set = (x, y, a) => { if (x >= 0 && y >= 0 && x < size && y < size) data.set([255, 255, 255, a], (y * size + x) * 4); };
    for (let i = 0; i < size; i++) { set(i, 0, 255); set(i, size - 1, 255); set(0, i, 255); set(size - 1, i, 255); }
    for (let stroke = 0; stroke < 7; stroke++) {
      const horizontal = rand() < 0.5, at = 2 + Math.floor(rand() * (size - 5)), from = 2 + Math.floor(rand() * 5), len = 3 + Math.floor(rand() * 7);
      for (let k = 0; k < len; k++) { for (let t = 0; t < 2; t++) horizontal ? set(from + k, at + t, 255) : set(at + t, from + k, 255); }
    }
    return { data, size };
  });
}

// Offline, deliberately designed storefronts rather than random marks. Node planners keep the data-texture fallback.
function storefrontPatterns(rand, n) {
  if (!globalThis.document?.createElement) return signPatterns(rand, n).map(({ data, size }) => new THREE.DataTexture(data, size, size, THREE.RGBAFormat));
  const labels = [['MIRROR', 'LAB', 'CREATE / TOGETHER'], ['NIGHT', 'NOODLES', 'OPEN 24H'], ['SKY', 'TRANSIT', 'PLATFORM 08'], ['ROBOT', 'REPAIR', 'PARTS & SERVICE']];
  return Array.from({ length: n }, (_, i) => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff'; ctx.lineWidth = 3;
    ctx.strokeRect(5, 5, 118, 246);
    ctx.beginPath(); ctx.arc(64, 64, 27, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(45, 78); ctx.lineTo(45, 50); ctx.lineTo(64, 66); ctx.lineTo(83, 50); ctx.lineTo(83, 78); ctx.stroke();
    const [a, b, sub] = labels[i % labels.length];
    ctx.textAlign = 'center'; ctx.font = 'bold 23px sans-serif'; ctx.fillText(a, 64, 130, 112); ctx.fillText(b, 64, 162, 112);
    ctx.fillRect(20, 184, 88, 2); ctx.font = '10px sans-serif'; ctx.fillText(sub, 64, 209, 110);
    return new THREE.CanvasTexture(canvas);
  });
}

// The signs: plain neon (bars and tubes) as one instanced mesh, each glyph pattern as another, and a halo under each. A few
// flicker (the halos do, in the shader). `update(seconds, camera)`.
export class Signs {
  constructor(signs, rand, patternCount = 4) {
    this.signs = signs;
    this.group = new THREE.Group();
    this.group.name = 'signs';
    const plain = signs.filter(s => s.kind !== 'panel');
    this.meshes = [];
    const make = (list, material) => {
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, Math.max(1, list.length));
      mesh.count = list.length;
      const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), axis = new THREE.Vector3(0, 1, 0);
      list.forEach((sign, i) => {
        matrix.compose(p.set(sign.x, sign.y, sign.z), q.setFromAxisAngle(axis, sign.yaw), s.set(sign.w, sign.h, 1));
        mesh.setMatrixAt(i, matrix);
        mesh.setColorAt(i, new THREE.Color(...sign.color));
      });
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.userData.scenery = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.meshes.push(mesh);
    };
    make(plain, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false }));
    storefrontPatterns(rand, patternCount).forEach((texture, k) => {
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      make(signs.filter(s => s.kind === 'panel' && s.pattern === k), new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false }));
    });
    this.halo = halos({ points: signs.map(s => [s.x, s.y, s.z, Math.max(s.w, s.h) * 1.1 + 1.2]), colors: signs.map(s => s.color), rand, flicker: 4 });
    this.group.add(this.halo.object);
  }

  update(seconds, camera) { this.halo.update(seconds, camera); }
}

// A soft additive pool of coloured light on the ground under each of `spots` ({x, z}), `radius` metres wide.
export class GlowPools {
  constructor(spots, colors, { radius = 5, y = 0.05 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'glow-pools';
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      map: glow(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0.55, toneMapped: false,
    }), Math.max(1, spots.length));
    this.mesh.count = spots.length;
    const matrix = new THREE.Matrix4();
    spots.forEach((spot, i) => {
      this.mesh.setMatrixAt(i, matrix.makeScale(radius * 2, 1, radius * 2).setPosition(spot.x, y, spot.z));
      this.mesh.setColorAt(i, new THREE.Color(colors[i % colors.length]));
    });
    this.mesh.userData.scenery = true;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.computeBoundingSphere();
    this.group.add(this.mesh);
  }
}

// A holographic billboard: a tall translucent panel of scrolling scanlines and a ring, in `color`, turning to face the viewer
// around the vertical axis. `update(seconds, camera)`.
export function hologram({ position, size = [4, 7], color = [0.3, 0.9, 1] }) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Vector3(...color) } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      void main() {
        vec2 c = vUv - 0.5;
        float scan = 0.55 + 0.45 * sin(vUv.y * 160.0 - uTime * 3.0);
        float ring = 1.0 - smoothstep(0.0, 0.03, abs(length(vec2(c.x * 1.6, c.y * 0.9 - 0.12)) - 0.26 - 0.02 * sin(uTime * 2.0)));
        float bars = step(0.5, fract(vUv.y * 9.0 - uTime * 0.25)) * step(abs(c.x), 0.35) * (1.0 - smoothstep(0.0, 0.08, abs(c.y + 0.28) - 0.16)) * 0.5;
        float edge = smoothstep(0.0, 0.08, vUv.x) * (1.0 - smoothstep(0.92, 1.0, vUv.x)) * smoothstep(0.0, 0.06, vUv.y) * (1.0 - smoothstep(0.94, 1.0, vUv.y));
        float flick = 0.96 + 0.04 * sin(uTime * 1.3);
        float a = (0.1 + ring * 0.9 + bars) * scan * edge * flick;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), material);
  mesh.position.set(...position);
  mesh.userData.scenery = true;
  mesh.frustumCulled = true;
  return {
    object: mesh,
    update(seconds, camera) {
      material.uniforms.uTime.value = seconds;
      if (camera) mesh.rotation.y = Math.atan2(camera.position.x - mesh.position.x, camera.position.z - mesh.position.z);
    },
  };
}
