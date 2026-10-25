import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildSetScene, EYE_HEIGHT } from './set-scene.js';
import { random } from './set-layout.js';
import { SETS } from './sets.js';
import { Dragon } from './dragon.js';
import { chunkScenery, fitScenery, prepareScenery } from './scenery.js';
import { applyEnvironment, createScene } from './scene.js';
import { buildSetAtmosphere } from './set-atmosphere.js';
import { loadSetProps } from './props.js';
import { worldSeed } from './world.js';
import { createAssembly } from './objects.js';

// The landing page's background: a title-screen panorama. The viewer stands in the middle of a preset's scene while
// the camera turns slowly all the way around, with a gentle bob and a little parallax from the pointer. Showing
// another preset crossfades between two WebGL canvases, so the motion never cuts. Scenes are built once per visit
// with a fresh random arrangement; the same build also renders the preset cards' pictures, so a card shows exactly
// the scene the background will show.
const SPIN = (Math.PI * 2) / 150;   // radians per second: one full turn every 150 s
const FADE_MS = 1400;
const FOV = 62;
const DEG = Math.PI / 180;

function makeRenderer(canvas, options = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', ...options });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  return renderer;
}

// Covers GLTF material arrays, textures and shadow maps as well as procedural meshes.
function disposeTree(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture && !value.userData.shared) textures.add(value);
    }
    if (node.isInstancedMesh) node.dispose();
    node.shadow?.dispose();
  });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
  root.removeFromParent();
}

export class Panorama {
  constructor(container, { reducedMotion = false } = {}) {
    this.container = container;
    this.destroyed = false;
    this.reducedMotion = reducedMotion;
    this.seed = Date.now() >>> 0;
    this.built = new Map(); // preset id -> {scene, update, dispose}
    this.loader = new GLTFLoader();
    this.models = new Map(); // preset id -> Promise of the set's model (or null), for presets that are model sets
    this.modelRoots = new Map(); // preset id -> the loaded model (or null once it has failed); present when ready
    this.wanted = null; // the preset the viewer last asked for, so a slow model never overrides a newer choice
    this.layers = [0, 1].map(() => {
      const canvas = document.createElement('canvas');
      container.append(canvas);
      return { canvas, renderer: makeRenderer(canvas), set: null, view: null };
    });
    this.top = 0;
    this.fadeUntil = 0;
    this.camera = new THREE.PerspectiveCamera(FOV, 1, .1, 400);
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    this.time = 0;
    this.last = null;
    this.raf = 0;
    this.onResize = () => this.resize();
    this.onPointer = e => {
      this.pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
    };
    this.resize();
  }

  // A preset whose id is a model set in sets.js (the Japanese garden) gets that model as its world, placed exactly as the
  // workspace places it. Resolves with the model, or null if the preset has none or it failed to load.
  modelFor(preset) {
    if (this.destroyed) return Promise.resolve(null);
    const set = SETS[preset.id];
    if (!set?.model) return Promise.resolve(null);
    if (!this.models.has(preset.id)) {
      this.models.set(preset.id, this.loader.loadAsync(new URL(set.model, import.meta.url).href).then(gltf => {
        fitScenery(gltf.scene, { scale: set.scale, center: set.center, floor: set.floor });
        if (set.chunk) chunkScenery(gltf.scene, set.chunk);
        prepareScenery(gltf.scene, set.shadows);
        return gltf.scene;
      }).catch(error => {
        console.warn(`[panorama] could not load ${set.name}: ${error.message}`);
        return null;
      }).then(root => {
        if (this.destroyed) { if (root) disposeTree(root); return null; }
        this.modelRoots.set(preset.id, root);
        return root;
      }));
    }
    return this.models.get(preset.id);
  }

  sceneFor(preset) {
    if (!this.built.has(preset.id)) {
      const model = this.modelRoots.get(preset.id);
      const definition = SETS[preset.id];
      let built;
      if (model && definition.environment?.sky) {
        // Model sets use the exact workspace look and extras, not the old primitive stand-in plus different lights.
        const { scene, look, blocks } = createScene();
        blocks.traverse(n => { n.geometry?.dispose(); n.material?.dispose(); }); blocks.removeFromParent();
        applyEnvironment(scene, look, definition.environment);
        const [x, z] = definition.workspace ?? [0, 0];
        look.sun.position.x += x; look.sun.position.z += z;
        look.sun.target.position.set(x, 0, z); scene.add(look.sun.target);
        scene.add(model);
        const atmosphere = buildSetAtmosphere(scene, definition);
        let props = null, alive = true, lastTime;
        built = {
          scene, position: [x, 1.4, z + 3], far: (definition.environment.fog?.[2] ?? 390) + 10, readyDone: false,
          update: (t, camera) => {
            const seconds = this.reducedMotion ? 10 : t;
            const dt = lastTime === undefined ? 0 : Math.min(Math.max(seconds - lastTime, 0), 0.1);
            lastTime = seconds;
            atmosphere.update(seconds, camera); props?.update(dt, seconds, camera);
          },
          dispose() {
            alive = false; props?.dispose(); atmosphere.dispose(); disposeTree(scene);
          },
        };
        const addShared = spec => {
          if (!alive) return;
          const root = createAssembly(spec); root.position.x += x; root.position.z += z;
          root.userData.scenery = true; scene.add(root);
        };
        built.ready = loadSetProps(definition, { scene, city: model, loader: this.loader, addShared, reducedMotion: this.reducedMotion, rand: random(worldSeed(definition.name)) })
          .then(loaded => { if (alive) props = loaded; else loaded?.dispose(); })
          .catch(error => console.warn(`[panorama] extras: ${error.message}`))
          .then(() => { built.readyDone = true; });
      } else {
        built = buildSetScene(preset, random(this.seed + this.built.size * 7919));
        if (model) {
          built.scene.add(model);
          const dispose = built.dispose;
          built.dispose = () => { disposeTree(model); dispose(); };
        }
        built.readyDone = true;
      }
      if (SETS[preset.id]?.dragon) { // a flier circles overhead; it follows the panorama's own clock, so reduced motion slows it too
        const dragon = new Dragon(built.scene, SETS[preset.id].dragon);
        const update = built.update;
        const dispose = built.dispose;
        built.update = (t, camera) => { update(t, camera); dragon.update(this.reducedMotion ? 10 : t); };
        built.dispose = () => { dragon.dispose(); dispose(); };
      }
      this.built.set(preset.id, built);
    }
    return this.built.get(preset.id);
  }

  // Crossfade the background to this preset's scene.
  show(preset) {
    if (!preset || this.destroyed) return;
    this.wanted = preset;
    if (SETS[preset.id]?.model && !this.modelRoots.has(preset.id)) {
      // The background stays where it is until the model is in, then comes in with the usual crossfade.
      this.modelFor(preset).then(() => { if (this.wanted === preset) this.show(preset); });
      return;
    }
    const set = this.sceneFor(preset);
    if (!set.readyDone) {
      set.ready.then(() => { if (this.wanted === preset) this.show(preset); });
      return;
    }
    const current = this.layers[this.top];
    if (current.set === set) return;
    if (!current.set) {
      Object.assign(current, { set, view: preset.view });
      current.canvas.style.opacity = '1';
      return;
    }
    const next = this.layers[1 - this.top];
    Object.assign(next, { set, view: preset.view });
    current.canvas.style.transition = 'none';
    current.canvas.style.opacity = '1'; // it may have been mid-fade; underneath, it must be solid
    current.canvas.style.zIndex = '0';
    next.canvas.style.transition = 'none';
    next.canvas.style.opacity = '0';
    next.canvas.style.zIndex = '1';
    void next.canvas.offsetWidth; // commit opacity 0 before the transition starts
    next.canvas.style.transition = `opacity ${this.reducedMotion ? 0 : FADE_MS}ms ease`;
    next.canvas.style.opacity = '1';
    this.top = 1 - this.top;
    this.fadeUntil = performance.now() + FADE_MS + 100;
  }

  // A still of the preset's scene from its `view`, for its card. Uses a temporary offscreen renderer.
  async thumbnails(presets, width = 480, height = 300) {
    const shots = new Map();
    if (this.destroyed) return shots;
    await Promise.all(presets.map(preset => this.modelFor(preset)));
    if (this.destroyed) return shots;
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const renderer = makeRenderer(canvas, { preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    const camera = new THREE.PerspectiveCamera(56, width / height, .1, 400);
    try { for (const preset of presets) {
      if (this.destroyed) break;
      const set = this.sceneFor(preset);
      await set.ready;
      if (this.destroyed) break;
      camera.position.fromArray(set.position ?? [0, EYE_HEIGHT, 0]);
      camera.far = set.far ?? 400; camera.updateProjectionMatrix();
      camera.rotation.set(preset.view.pitch * DEG, preset.view.yaw * DEG, 0, 'YXZ');
      set.update(10, camera);
      renderer.render(set.scene, camera);
      shots.set(preset.id, canvas.toDataURL('image/jpeg', .86));
    } } finally {
      renderer.dispose();
      renderer.forceContextLoss();
    }
    return shots;
  }

  start() {
    if (this.raf || this.destroyed) return;
    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointermove', this.onPointer, { passive: true });
    const loop = now => {
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = null;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointermove', this.onPointer);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.wanted = null;
    this.stop();
    for (const root of this.modelRoots.values()) if (root && !root.parent) disposeTree(root);
    for (const set of this.built.values()) set.dispose();
    this.built.clear();
    this.models.clear();
    this.modelRoots.clear();
    for (const layer of this.layers) {
      layer.renderer.dispose();
      layer.renderer.forceContextLoss();
      layer.canvas.remove();
    }
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const layer of this.layers) layer.renderer.setSize(w, h, false);
  }

  frame(now) {
    const dt = this.last === null ? 0 : Math.min((now - this.last) / 1000, .1);
    this.last = now;
    this.time += this.reducedMotion ? 0 : dt;
    const p = this.pointer;
    const k = this.reducedMotion ? 0 : 1 - Math.exp(-2 * dt);
    p.x += (p.tx - p.x) * k;
    p.y += (p.ty - p.y) * k;
    const fading = now < this.fadeUntil;
    this.layers.forEach((layer, i) => {
      if (!layer.set || (i !== this.top && !fading)) return;
      const t = this.time;
      this.camera.position.fromArray(layer.set.position ?? [0, EYE_HEIGHT, 0]);
      this.camera.far = layer.set.far ?? 400; this.camera.updateProjectionMatrix();
      this.camera.position.y += this.reducedMotion ? 0 : Math.sin(t * .45) * .04;
      this.camera.rotation.set(layer.view.pitch * DEG - p.y * .035, layer.view.yaw * DEG - t * SPIN - p.x * .07, 0, 'YXZ');
      layer.set.update(t, this.camera);
      layer.renderer.render(layer.set.scene, this.camera);
    });
  }
}
