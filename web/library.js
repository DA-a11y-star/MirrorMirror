// The object library: built-in shapes plus every object made by voice, so people can add more of the same without
// speaking again (CLAUDE.md, planned work C). It is per laptop and never synced: adding an entry creates an ordinary
// assembly with a new instance id, which reaches the other laptop through the normal Objects.add -> op:add path.
//
// An entry is { id, name, spec, source: 'builtin' | 'voice', createdAt }. `spec` is a template: a valid assembly
// (object-protocol.js) whose parts are grounded (lowest point at y = 0) and centered on x/z, with an identity pose.
// Voice entries are deduplicated by a hash of their parts and persisted in localStorage (capped); built-ins are fixed.
// Thumbnails are rendered on demand by library-ui.js rather than stored, which keeps the saved data small.
import { renderSpec, validAssembly } from './object-protocol.js';

export const LIBRARY_KEY = 'mirrormirror.library.v1';
export const LIBRARY_FORMAT = 'mirrormirror.library';
export const MAX_SAVED = 80;
export const MAX_SAVED_BYTES = 1_500_000;
const MAX_NAME = 60;
const IDENTITY = [0, 0, 0, 1];
const DEG = Math.PI / 180;

// Quaternion [x, y, z, w] from Euler degrees (three.js 'XYZ' order), so built-ins can be written with angles.
export function quat(x = 0, y = 0, z = 0) {
  const [cx, cy, cz] = [x, y, z].map(a => Math.cos(a * DEG / 2));
  const [sx, sy, sz] = [x, y, z].map(a => Math.sin(a * DEG / 2));
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz]
    .map(v => Math.round(v * 1e6) / 1e6);
}

const part = (id, shape, size, position, color, rotation = IDENTITY) => ({ id, shape, size, position, quaternion: rotation, color });
const builtin = (id, name, parts) => ({ id, name, source: 'builtin', createdAt: 0,
  spec: { version: 1, id, name, position: [0, 0, 0], quaternion: IDENTITY, parts } });
const WOOD = '#c98a4b';
const DARK_WOOD = '#8a5a33';

// Sized like the workspace's starter blocks (about 0.4 m), all from the four supported primitives.
export const BUILTINS = [
  builtin('cube', 'Cube', [part('cube', 'box', [.4, .4, .4], [0, .2, 0], '#e76f51')]),
  builtin('sphere', 'Sphere', [part('ball', 'sphere', [.4, .4, .4], [0, .2, 0], '#4c6ef5')]),
  builtin('cylinder', 'Cylinder', [part('drum', 'cylinder', [.35, .5, .35], [0, .25, 0], '#2a9d8f')]),
  builtin('cone', 'Cone', [part('cone', 'cone', [.4, .55, .4], [0, .275, 0], '#e9c46a')]),
  builtin('plank', 'Plank', [part('plank', 'box', [.9, .06, .2], [0, .03, 0], WOOD)]),
  builtin('wall', 'Wall', [part('wall', 'box', [.9, .6, .08], [0, .3, 0], '#b9c0ca'),
    part('cap', 'box', [.94, .04, .1], [0, .62, 0], '#9aa3af')]),
  builtin('chair', 'Chair', [
    part('seat', 'box', [.42, .06, .42], [0, .45, 0], WOOD),
    ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([x, z], i) => part(`leg-${i + 1}`, 'box', [.05, .42, .05], [x * .18, .21, z * .18], DARK_WOOD)),
    part('back', 'box', [.42, .42, .05], [0, .69, -.185], WOOD)]),
  builtin('table', 'Table', [
    part('top', 'box', [.9, .06, .6], [0, .72, 0], WOOD),
    ...[[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([x, z], i) => part(`leg-${i + 1}`, 'box', [.06, .69, .06], [x * .4, .345, z * .25], DARK_WOOD))]),
  builtin('tree', 'Tree', [
    part('trunk', 'cylinder', [.12, .5, .12], [0, .25, 0], '#6b4a2e'),
    part('leaves', 'cone', [.55, .7, .55], [0, .8, 0], '#3c8160'),
    part('crown', 'cone', [.38, .45, .38], [0, 1.12, 0], '#4c9a72')]),
  builtin('house', 'House', [
    part('walls', 'box', [.7, .5, .6], [0, .25, 0], '#e8dcc4'),
    // One box turned 45 degrees: its upper half is a gabled roof, its lower half hides inside the walls.
    part('roof', 'box', [.5, .5, .66], [0, .5, 0], '#b5653a', quat(0, 0, 45)),
    part('door', 'box', [.14, .24, .02], [0, .12, .305], DARK_WOOD),
    part('window', 'box', [.12, .1, .02], [.2, .3, .305], '#9fc6e8'),
    part('chimney', 'box', [.08, .22, .08], [.15, .74, -.1], '#8f4a2c')]),
];

const round = v => Math.round(v * 1e4) / 1e4;

// Axis-aligned half extents of a rotated box of `size` (spheres, cylinders and cones fit inside theirs).
function halfExtents(size, [x, y, z, w]) {
  const m = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  return m.map(row => row.reduce((sum, v, i) => sum + Math.abs(v) * size[i] / 2, 0));
}

// Any valid assembly -> a template: identity pose, parts grounded and centered, numbers rounded, extra fields dropped.
export function templateOf(spec, id = spec.id, name = spec.name) {
  const clean = renderSpec(spec);
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const p of clean.parts) {
    const half = halfExtents(p.size, p.quaternion);
    for (let i = 0; i < 3; i++) {
      low[i] = Math.min(low[i], p.position[i] - half[i]);
      high[i] = Math.max(high[i], p.position[i] + half[i]);
    }
  }
  const origin = [(low[0] + high[0]) / 2, low[1], (low[2] + high[2]) / 2];
  return renderSpec({
    version: 1, id, name: String(name).slice(0, MAX_NAME), position: [0, 0, 0], quaternion: IDENTITY,
    parts: clean.parts.map(p => ({ ...p, size: p.size.map(round), position: p.position.map((v, i) => round(v - origin[i])),
      quaternion: p.quaternion.map(round) })),
  });
}

// The assembly spec a scene object would be rebuilt from, for duplicating it: its recipe scaled by the root, or,
// for a starter block (a plain box mesh), an equivalent one-part box. The caller supplies the new id and pose.
export function specOfObject(root) {
  if (root.userData.spec) {
    const spec = renderSpec(root.userData.spec);
    const s = root.scale.toArray();
    return { ...spec, parts: spec.parts.map(p => ({ ...p, size: p.size.map((v, i) => v * s[i]), position: p.position.map((v, i) => v * s[i]) })) };
  }
  const g = root.geometry?.parameters;
  if (!g || ![g.width, g.height, g.depth].every(Number.isFinite)) return null;
  const size = [g.width * root.scale.x, g.height * root.scale.y, g.depth * root.scale.z];
  return { version: 1, id: 'block', name: 'Block', position: [0, 0, 0], quaternion: IDENTITY,
    parts: [{ id: 'block', shape: 'box', size, position: [0, 0, 0], quaternion: IDENTITY, color: `#${root.material.color.getHexString()}` }] };
}

// Same shape -> same hash, whatever it is called or where it was standing.
export function shapeHash(spec) {
  const text = JSON.stringify(templateOf(spec, 'x', 'x').parts.map(p => [p.shape, p.size, p.position, p.quaternion, p.color.toLowerCase()]));
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// Words that don't name the object: "make a chair", "build another one table please".
const FILLER = new Set(['a', 'an', 'the', 'some', 'please', 'make', 'build', 'create', 'add', 'give', 'me', 'us', 'i',
  'want', 'need', 'would', 'like', 'new', 'another', 'one', 'more', 'of', 'can', 'you', 'could', 'put', 'place', 'spawn',
  'bring', 'get', 'let', 's', 'lets', 'here', 'there', 'now']);
// The spoken wake phrase ("mirror mirror, make a chair"), as voice/main.py's clean_command strips it. Only the
// doubled phrase, so an object called "Mirror" still matches "a mirror".
const WAKE = /^\W*mirror[\s,.-]+mirror\b(?:\W+on the wall\b)?/i;
export function normalizeName(text) {
  return String(text).replace(WAKE, ' ').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !FILLER.has(w))
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}

export class Library {
  // `storage` is a localStorage-like object, or null to keep the library in memory only (private windows, tests).
  constructor({ storage = null, now = () => Date.now(), random = Math.random } = {}) {
    this.storage = storage;
    this.now = now;
    this.random = random;
    this.saved = this.load();
    this.instances = 0;
  }

  load() {
    try {
      const raw = this.storage?.getItem(LIBRARY_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return (Array.isArray(data?.entries) ? data.entries : []).flatMap(e => {
        try { return [this.entryFrom(e.spec, e.name, e.createdAt, e.id)]; } catch { return []; }
      });
    } catch {
      return [];
    }
  }

  persist() {
    // Oldest saved objects go first when the cap is reached; built-ins are never stored.
    while (this.saved.length > MAX_SAVED) this.saved.shift();
    let text = JSON.stringify({ version: 1, entries: this.saved });
    while (text.length > MAX_SAVED_BYTES && this.saved.length) {
      this.saved.shift();
      text = JSON.stringify({ version: 1, entries: this.saved });
    }
    try { this.storage?.setItem(LIBRARY_KEY, text); } catch { /* quota or blocked storage: keep it for this visit */ }
  }

  entryFrom(spec, name = spec?.name, createdAt = this.now(), id = null) {
    if (!validAssembly(spec)) throw new Error('Not a valid object');
    const entryId = id && /^v-[a-z0-9]{1,16}$/.test(id) ? id : `v-${shapeHash(spec)}`;
    const label = String(name ?? '').trim().slice(0, MAX_NAME) || 'Object';
    return { id: entryId, name: label, source: 'voice', createdAt: Number(createdAt) || this.now(),
      spec: templateOf(spec, entryId, label) };
  }

  entries() {
    return [...[...this.saved].reverse(), ...BUILTINS]; // newest saved first, then the built-ins
  }

  get(id) {
    return this.entries().find(e => e.id === id) ?? null;
  }

  // Save an object made by voice (or imported). Returns { entry, added }; an identical shape is not saved twice.
  save(spec, name = spec?.name) {
    const entry = this.entryFrom(spec, name);
    const existing = this.saved.find(e => e.id === entry.id);
    if (existing) return { entry: existing, added: false };
    this.saved.push(entry);
    this.persist();
    return { entry, added: true };
  }

  rename(id, name) {
    const entry = this.saved.find(e => e.id === id);
    const label = String(name ?? '').trim().slice(0, MAX_NAME);
    if (!entry || !label) return false;
    entry.name = label;
    entry.spec = { ...entry.spec, name: label };
    this.persist();
    return true;
  }

  remove(id) {
    const before = this.saved.length;
    this.saved = this.saved.filter(e => e.id !== id);
    if (this.saved.length === before) return false;
    this.persist();
    return true;
  }

  // A fresh assembly spec for the scene: same shape, new instance id, so every copy is its own shared object.
  instantiate(id) {
    const entry = this.get(id);
    if (!entry) throw new Error('That object is no longer in the library');
    const tag = Math.floor(this.random() * 36 ** 6).toString(36).padStart(6, '0');
    return renderSpec({ ...entry.spec, id: `lib-${entry.id}-${(++this.instances).toString(36)}${tag}` });
  }

  // The entry a request names outright ("a chair", "make another tree"), or null. A description with any extra
  // detail ("a blue chair with wooden legs") does not match and goes to Muse. Saved objects win over built-ins.
  match(text) {
    const wanted = normalizeName(text);
    if (!wanted) return null;
    return this.entries().find(e => normalizeName(e.name) === wanted) ?? null;
  }

  exportJSON() {
    return JSON.stringify({ format: LIBRARY_FORMAT, version: 1,
      entries: this.saved.map(({ name, spec, createdAt }) => ({ name, spec, createdAt })) }, null, 1);
  }

  // Accepts an export file, a bare list of entries, or a single assembly spec. Returns { added, skipped }.
  importJSON(text) {
    const data = JSON.parse(text);
    const items = data?.format === LIBRARY_FORMAT ? data.entries : Array.isArray(data) ? data : [data];
    if (!Array.isArray(items)) throw new Error('Not a library file');
    let added = 0;
    let skipped = 0;
    for (const item of items) {
      try {
        const spec = item?.spec ?? item;
        if (this.save(spec, item?.name ?? spec?.name).added) added++;
        else skipped++;
      } catch {
        skipped++;
      }
    }
    return { added, skipped };
  }
}
