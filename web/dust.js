import * as THREE from 'three';

// A dust cloud for "building": it swirls and billows where the next object will appear while the voice request runs
// (`start`), then bursts outward and thins away when the object arrives (`burst`). Local view only: it never touches
// the synced scene. One Points object with per-particle size and alpha, so it is a single draw call.
const COUNT = 140;
const RADIUS = 0.42; // m, resting cloud radius
const BURST_S = 1.1;
const FADE_IN_S = 0.5;
const FADE_OUT_S = 0.6;
const RISE_PER_S = 0.32; // whirl cycles per second

const VERTEX = `
  attribute float aSize; attribute float aAlpha; attribute float aTone;
  varying float vAlpha; varying float vTone;
  uniform float uScale; uniform float uMax;
  void main() {
    vAlpha = aAlpha; vTone = aTone;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(aSize * uScale / max(0.05, -mv.z), uMax);
    gl_Position = projectionMatrix * mv;
  }`;
const FRAGMENT = `
  varying float vAlpha; varying float vTone;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float soft = pow(1.0 - d, 0.9);
    vec3 dust = mix(vec3(0.62, 0.52, 0.38), vec3(0.83, 0.75, 0.62), vTone);
    gl_FragColor = vec4(dust, soft * vAlpha);
  }`;

const rand = (a, b) => a + Math.random() * (b - a);

export class DustCloud {
  constructor(scene) {
    this.center = new THREE.Vector3();
    this.radius = RADIUS;
    this.state = 'idle'; // idle | building | burst | fading
    this.t = 0;
    this.level = 0; // 0..1 how much of the cloud is shown while building
    this.p = Array.from({ length: COUNT }, () => ({
      theta: 0, r: 0, h: 0, w: 0, phase: 0, size: 0, tone: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    }));
    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(COUNT * 3);
    this.sizes = new Float32Array(COUNT);
    this.alphas = new Float32Array(COUNT);
    this.tones = new Float32Array(COUNT);
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geometry.setAttribute('aTone', new THREE.BufferAttribute(this.tones, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, fog: false,
      uniforms: { uScale: { value: 600 }, uMax: { value: 220 } },
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false; // positions move every frame
    this.points.visible = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this._seed();
  }

  _seed() {
    for (const q of this.p) {
      q.theta = rand(0, Math.PI * 2);
      q.r = Math.sqrt(Math.random()); // 0..1, denser toward the middle
      q.h = rand(-0.5, 0.9);
      q.w = rand(0.8, 2.2) * (Math.random() < 0.5 ? -1 : 1) * (1.2 - q.r * 0.5); // inner puffs swirl faster
      q.phase = rand(0, 6.28);
      q.size = rand(0.2, 0.42);
      q.tone = Math.random();
    }
  }

  // Begin (or keep) swirling at `center` (world metres, the middle of the cloud).
  start(center, radius = RADIUS) {
    this.center.copy(center);
    this.radius = radius;
    if (this.state === 'building') return;
    if (this.state === 'idle' || this.state === 'fading') this._seed();
    this.state = 'building';
    this.t = 0;
    this.points.visible = true;
  }

  // Slide the waiting cloud, e.g. when the next free spot changes.
  move(center) {
    this.center.copy(center);
  }

  // Stop without a burst (error, cancelled): the cloud just thins away.
  stop() {
    if (this.state === 'building') { this.state = 'fading'; this.t = 0; }
  }

  // The object arrived at `center`, about `radius` big: the cloud blows outward from it and thins away.
  burst(center, radius = RADIUS) {
    if (this.state === 'idle') this._seed();
    this.center.copy(center);
    this.radius = Math.max(0.2, radius);
    this.points.visible = true;
    this.state = 'burst';
    this.t = 0;
    this.level = 1;
    for (const q of this.p) {
      // Respawn inside the object's volume, then throw outward and a little up.
      const a = q.theta;
      const rr = this.radius * (0.4 + 0.6 * q.r);
      q.pos.set(Math.cos(a) * rr, rand(0.0, 1.1) * this.radius, Math.sin(a) * rr);
      const out = Math.hypot(q.pos.x, q.pos.z) || 1;
      const speed = rand(0.4, 1.1);
      q.vel.set((q.pos.x / out) * speed, rand(0.15, 0.7), (q.pos.z / out) * speed);
      q.size = rand(0.25, 0.45);
    }
  }

  get active() {
    return this.state !== 'idle';
  }

  update(dt) {
    if (this.state === 'idle') return;
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.t += dt;
    const { positions, sizes, alphas, tones, center } = this;

    if (this.state === 'building' || this.state === 'fading') {
      this.level = this.state === 'building' ? Math.min(1, this.t / FADE_IN_S) : Math.max(0, this.level - dt / FADE_OUT_S);
      if (this.state === 'fading' && this.level <= 0) { this.state = 'idle'; this.points.visible = false; return; }
      // A rising dust whirl: every puff climbs a funnel (wide at the bottom, narrow at the top), spinning faster as it
      // narrows, and fades in and out along the way. It never settles, so the eye always has something to follow.
      const height = this.radius * 2;
      const scale = (this.radius / RADIUS) ** 0.5;
      this.p.forEach((q, i) => {
        const u = (q.phase / 6.2832 + this.t * RISE_PER_S * (0.7 + 0.6 * q.r)) % 1;
        const funnel = 0.28 + 0.72 * (1 - u) ** 0.7;
        const rr = this.radius * funnel * (0.35 + 0.65 * q.r) * (1 + 0.12 * Math.sin(this.t * 2.3 + q.phase));
        const angle = q.theta + this.t * q.w * (1.6 - 0.9 * u);
        positions[i * 3] = center.x + Math.cos(angle) * rr;
        positions[i * 3 + 1] = center.y - this.radius * 0.5 + 0.02 + u * height;
        positions[i * 3 + 2] = center.z + Math.sin(angle) * rr;
        sizes[i] = q.size * (0.7 + 0.7 * u) * (0.6 + 0.4 * this.level) * scale;
        alphas[i] = this.level * Math.sin(Math.PI * u) ** 0.8 * (0.36 + 0.18 * (1 - q.r));
        tones[i] = q.tone;
      });
    } else if (this.state === 'burst') {
      const life = this.t / BURST_S;
      if (life >= 1) { this.state = 'idle'; this.points.visible = false; return; }
      const drag = Math.exp(-2.2 * dt);
      this.p.forEach((q, i) => {
        q.vel.multiplyScalar(drag);
        q.vel.y += 0.25 * dt; // dust drifts up as it thins
        q.pos.addScaledVector(q.vel, dt);
        positions[i * 3] = center.x + q.pos.x;
        positions[i * 3 + 1] = center.y - this.radius * 0.5 + q.pos.y;
        positions[i * 3 + 2] = center.z + q.pos.z;
        sizes[i] = q.size * (1 + life * 1.0) * (this.radius / RADIUS) ** 0.5;
        alphas[i] = (1 - life) ** 1.4 * (0.5 - 0.2 * q.r);
        tones[i] = q.tone;
      });
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = g.attributes.aTone.needsUpdate = true;
  }

  // Match the point size to the render height so the cloud looks the same at any window size.
  setViewport(heightPx, fovDeg) {
    this.material.uniforms.uScale.value = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    this.material.uniforms.uMax.value = heightPx * 0.22; // no puff is ever bigger than ~a fifth of the screen
  }
}
