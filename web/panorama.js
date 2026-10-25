import * as THREE from 'three';
import { buildSetScene, EYE_HEIGHT } from './set-scene.js';
import { random } from './set-layout.js';

// The landing page's background: a title-screen panorama. The viewer stands in the middle of a preset's scene while
// the camera turns slowly all the way around, with a gentle bob and a little parallax from the pointer. Showing
// another preset crossfades between two WebGL canvases, so the motion never cuts. Scenes are built once per visit
// with a fresh random arrangement; the same build also renders the preset cards' pictures, so a card shows exactly
// the scene the background will show.
const SPIN = (Math.PI * 2) / 150;   // radians per second: one full turn every 150 s
const FADE_MS = 1400;
const REDUCED_MOTION = .15;         // speed factor when the viewer asks for reduced motion
const FOV = 62;
const DEG = Math.PI / 180;

function makeRenderer(canvas, options = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', ...options });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  return renderer;
}

export class Panorama {
  constructor(container, { reducedMotion = false } = {}) {
    this.container = container;
    this.reducedMotion = reducedMotion;
    this.seed = Date.now() >>> 0;
    this.built = new Map(); // preset id -> {scene, update, dispose}
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

  sceneFor(preset) {
    if (!this.built.has(preset.id)) {
      this.built.set(preset.id, buildSetScene(preset, random(this.seed + this.built.size * 7919)));
    }
    return this.built.get(preset.id);
  }

  // Crossfade the background to this preset's scene.
  show(preset) {
    if (!preset) return;
    const set = this.sceneFor(preset);
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
  thumbnails(presets, width = 480, height = 300) {
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const renderer = makeRenderer(canvas, { preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    const camera = new THREE.PerspectiveCamera(56, width / height, .1, 400);
    const shots = new Map();
    for (const preset of presets) {
      const set = this.sceneFor(preset);
      camera.position.set(0, EYE_HEIGHT, 0);
      camera.rotation.set(preset.view.pitch * DEG, preset.view.yaw * DEG, 0, 'YXZ');
      set.update(0);
      renderer.render(set.scene, camera);
      shots.set(preset.id, canvas.toDataURL('image/jpeg', .86));
    }
    renderer.dispose();
    renderer.forceContextLoss();
    return shots;
  }

  start() {
    if (this.raf) return;
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
    this.stop();
    for (const set of this.built.values()) set.dispose();
    this.built.clear();
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
    this.time += dt * (this.reducedMotion ? REDUCED_MOTION : 1);
    const p = this.pointer;
    const k = this.reducedMotion ? 0 : 1 - Math.exp(-2 * dt);
    p.x += (p.tx - p.x) * k;
    p.y += (p.ty - p.y) * k;
    const fading = now < this.fadeUntil;
    this.layers.forEach((layer, i) => {
      if (!layer.set || (i !== this.top && !fading)) return;
      const t = this.time;
      this.camera.position.set(0, EYE_HEIGHT + (this.reducedMotion ? 0 : Math.sin(t * .45) * .04), 0);
      this.camera.rotation.set(layer.view.pitch * DEG - p.y * .035, layer.view.yaw * DEG - t * SPIN - p.x * .07, 0, 'YXZ');
      layer.set.update(t);
      layer.renderer.render(layer.set.scene, this.camera);
    });
  }
}
