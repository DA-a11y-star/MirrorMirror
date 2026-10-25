import * as THREE from 'three';
import { random, scatterLayout } from './set-layout.js';

// Builds a preset's scene (see presets.js for the format) from the workspace's four primitives: a gradient sky
// dome, fog, a ground disc, sun and sky light, the landmarks and the randomly scattered props, and optional
// glowing motes. Every copy of an object is one InstancedMesh per part, so a forest of fifty pines is a few draw
// calls. Low-poly flat shading, like the rest of the world.
export const EYE_HEIGHT = 1.7;
const GROUND_RADIUS = 95;
const SKY_RADIUS = 120;
const DEG = Math.PI / 180;

const geometries = new Map(); // shared by every scene; never disposed
function geometry(shape, sides) {
  const key = `${shape}:${sides ?? ''}`;
  if (!geometries.has(key)) {
    const n = sides ?? 14;
    const make = {
      box: () => new THREE.BoxGeometry(1, 1, 1),
      sphere: () => new THREE.SphereGeometry(.5, n, Math.max(3, Math.round(n * .6))),
      cylinder: () => new THREE.CylinderGeometry(.5, .5, 1, n),
      cone: () => new THREE.ConeGeometry(.5, 1, n),
    }[shape];
    geometries.set(key, make());
  }
  return geometries.get(key);
}

// A facade: a grid of windows, some lit. Returns the color map and a matching glow map.
function windowTextures(pattern, base, rand) {
  const cell = 16;
  const w = pattern.cols * cell;
  const h = pattern.rows * cell;
  const [paint, glow] = [0, 1].map(() => Object.assign(document.createElement('canvas'), { width: w, height: h }));
  const pc = paint.getContext('2d');
  const gc = glow.getContext('2d');
  pc.fillStyle = base;
  pc.fillRect(0, 0, w, h);
  gc.fillStyle = '#000';
  gc.fillRect(0, 0, w, h);
  for (let r = 0; r < pattern.rows; r++) {
    for (let c = 0; c < pattern.cols; c++) {
      const lit = rand() < pattern.lit;
      pc.fillStyle = lit ? pattern.glow : pattern.color;
      pc.fillRect(c * cell + 4, r * cell + 3, cell - 8, cell - 6);
      if (lit) {
        gc.fillStyle = pattern.glow;
        gc.fillRect(c * cell + 4, r * cell + 3, cell - 8, cell - 6);
      }
    }
  }
  return [paint, glow].map(canvas => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    return texture;
  });
}

function skyDome(top, bottom) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(top) }, bottom: { value: new THREE.Color(bottom) } },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; varying vec3 vDir;
      void main() {
        float k = pow(clamp(vDir.y, 0.0, 1.0), 0.55);
        gl_FragColor = vec4(mix(bottom, top, k), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 32, 16), material);
  dome.renderOrder = -1;
  return dome;
}

// A soft round dot, so motes glow instead of rendering as squares.
function glowSprite() {
  const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(.25, 'rgba(255,255,255,.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function motes(spec, rand) {
  const base = new Float32Array(spec.count * 3);
  const phase = new Float32Array(spec.count);
  for (let i = 0; i < spec.count; i++) {
    const r = Math.sqrt(rand()) * spec.radius;
    const a = rand() * Math.PI * 2;
    base.set([Math.cos(a) * r, .3 + rand() * spec.height, Math.sin(a) * r], i * 3);
    phase[i] = rand() * Math.PI * 2;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
  const points = new THREE.Points(geom, new THREE.PointsMaterial({
    color: spec.color, size: .22, map: glowSprite(), transparent: true, opacity: .9, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  points.userData.update = t => {
    const pos = geom.attributes.position.array;
    for (let i = 0; i < spec.count; i++) {
      const p = phase[i];
      pos[i * 3] = base[i * 3] + Math.sin(t * .3 + p) * .6;
      pos[i * 3 + 1] = base[i * 3 + 1] + Math.sin(t * .7 + p * 2) * .25;
      pos[i * 3 + 2] = base[i * 3 + 2] + Math.cos(t * .25 + p) * .6;
    }
    geom.attributes.position.needsUpdate = true;
    points.material.opacity = .55 + .35 * Math.sin(t * 1.3);
  };
  return points;
}

// -> {scene, update(seconds), dispose()}. `rand` decides the random props; pass random(seed) to repeat a layout.
export function buildSetScene(preset, rand = random(Date.now())) {
  const env = preset.environment;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(env.sky[1]);
  scene.fog = new THREE.Fog(env.fog[0], env.fog[1], env.fog[2]);
  scene.add(skyDome(env.sky[0], env.sky[1]));

  scene.add(new THREE.HemisphereLight(env.ambient[0], env.ambient[1], env.ambient[2]));
  const sun = new THREE.DirectionalLight(env.sun.color, env.sun.intensity);
  sun.position.fromArray(env.sun.position).normalize().multiplyScalar(45);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 120 });
  sun.shadow.bias = -.0004;
  sun.shadow.normalBias = .03;
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.CircleGeometry(GROUND_RADIUS, 64),
    new THREE.MeshStandardMaterial({ color: env.ground, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const materials = new Map();
  const material = p => {
    const key = JSON.stringify([p.color, p.emissive, p.pattern]);
    if (!materials.has(key)) {
      const m = new THREE.MeshStandardMaterial({ color: p.color, roughness: .85, metalness: 0, flatShading: true });
      if (p.emissive) {
        m.emissive.set(p.emissive);
        m.emissiveIntensity = 1.2;
      }
      if (p.pattern) {
        const [map, glow] = windowTextures(p.pattern, p.color, rand);
        m.color.set('#ffffff');
        m.map = map;
        m.emissiveMap = glow;
        m.emissive.set('#ffffff');
        m.emissiveIntensity = 1.1;
      }
      materials.set(key, m);
    }
    return materials.get(key);
  };

  // One InstancedMesh per part of each object, holding every copy of that object.
  const byObject = new Map();
  const layout = scatterLayout(preset, rand);
  for (const item of layout) {
    if (!byObject.has(item.object)) byObject.set(item.object, []);
    byObject.get(item.object).push(item);
  }
  const instance = new THREE.Matrix4();
  const partMatrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (const [name, items] of byObject) {
    for (const p of preset.objects[name]) {
      const mesh = new THREE.InstancedMesh(geometry(p.shape, p.sides), material(p), items.length);
      partMatrix.compose(v.fromArray(p.pos), q.setFromEuler(e.set(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG)),
        s.fromArray(p.size));
      items.forEach((item, i) => {
        instance.compose(v.set(item.x, item.y, item.z), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, item.yaw * DEG),
          s.set(item.scale, item.scale * item.stretch, item.scale));
        mesh.setMatrixAt(i, instance.multiply(partMatrix));
      });
      mesh.computeBoundingSphere();
      mesh.castShadow = !p.emissive;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  const particles = env.particles ? motes(env.particles, rand) : null;
  if (particles) scene.add(particles);

  return {
    scene,
    layout, // where every object went, so the workspace can find the floors
    update(t) { particles?.userData.update(t); },
    dispose() {
      const shared = new Set(geometries.values());
      const owned = new Set(materials.values());
      scene.traverse(node => {
        if (node.isInstancedMesh) node.dispose();
        else if (node.geometry && !shared.has(node.geometry)) node.geometry.dispose();
        if (node.material && !owned.has(node.material)) node.material.dispose?.();
      });
      for (const m of materials.values()) {
        m.map?.dispose();
        m.emissiveMap?.dispose();
        m.dispose();
      }
    },
  };
}
