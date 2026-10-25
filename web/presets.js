// Presets: named, themed scenes shown on the landing page (and, later, the source of a set's world).
//
// A preset is one self-contained JSON file. The built-ins live in web/presets/<id>/preset.json and are listed in
// web/presets/index.json; a future "import preset" button will feed a user's file through the same parsePreset(),
// so built-in and imported presets are held to exactly the same rules.
//
// A preset describes a scene, built from the same four primitives as the workspace's objects:
//   {
//     "format": "mirrormirror.preset", "version": 1,
//     "id": "forest", "name": "Enchanted Forest", "description": "optional, one line",
//     "tint": "#2a9d8f",                               // optional accent for the card's selected state
//     "thumbnail": "card.png",                         // optional image; otherwise the card shows a render
//     "view": { "yaw": 0, "pitch": -4 },               // optional, degrees: where the card render looks
//     "environment": {
//       "sky": ["#0e1633", "#3b4f7a"],                 // zenith, horizon
//       "fog": ["#2a3a5c", 6, 38],                     // color, near, far (meters)
//       "ground": "#23402f",
//       "sun": { "color": "#9fb4ff", "intensity": 1, "position": [-6, 12, 4] },
//       "ambient": ["#8090c0", "#1a2a20", 1],          // hemisphere sky color, ground color, intensity
//       "particles": { "color": "#f4e46a", "count": 80, "radius": 14, "height": 3 }   // optional, glowing motes
//     },
//     "objects": { "pine": [ { "shape": "cone", "size": [2, 3, 2], "pos": [0, 2, 0], "color": "#2f6b4f" } ] },
//     "place":   [ { "object": "pine", "pos": [0, 0, -12], "yaw": 30, "scale": 2, "clear": 3 } ],   // landmarks
//     "scatter": [ { "objects": ["pine", "pine", "rock"], "count": [30, 45], "radius": [4, 26] } ]  // random props
//   }
// Parts: shape box|sphere|cylinder|cone, size [x, y, z] (diameters for round shapes), pos, optional rot (degrees),
// color, optional emissive (a glow color), optional sides (low-poly facet count), optional pattern
// {"type": "windows", "rows", "cols", "lit" (0-1), "color", "glow"} for building facades.
// Scatter: count and radius ranges, optional scale [min, max], stretch [min, max] (height only), spacing (meters),
// mode "ring" (default) or "roads" (along the x and z axes, `width` wide), keepOffRoads (meters from the axes),
// y (height the props stand at, e.g. on a deck), snap (round the random facing to multiples of this many degrees).
// A place entry's `clear` keeps scattered props that far away; a place without an object only reserves space.
//
// Imported files are untrusted: sizes and counts are capped, colors must be hex, and a thumbnail URL must resolve to
// http(s), blob: or a data:image/ URI. Validation returns a new, normalized object and never the input.
export const PRESET_FORMAT = 'mirrormirror.preset';
export const PRESET_VERSION = 1;
export const DEFAULT_TINT = '#4c6ef5';
export const SHAPES = ['box', 'sphere', 'cylinder', 'cone'];
export const LIMITS = { objects: 40, parts: 40, place: 80, scatter: 12, scatterTotal: 400, size: 200, extent: 90, particles: 300 };
const ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const OBJECT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i;
const MAX_NAME = 40;
const MAX_TEXT = 160;
const REGISTRY_URL = new URL('./presets/index.json', import.meta.url);

export class PresetError extends Error {}

function fail(message) {
  throw new PresetError(message);
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

function text(value, field, max, required) {
  if ((value === undefined || value === '') && !required) return '';
  if (typeof value !== 'string' || !value.trim()) fail(`"${field}" must be a non-empty string`);
  if (value.length > max) fail(`"${field}" is longer than ${max} characters`);
  return value.trim();
}

function color(value, field) {
  if (typeof value !== 'string' || !HEX.test(value)) fail(`"${field}" must be a color like #4c6ef5`);
  return value.toLowerCase();
}

function number(value, field, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) fail(`"${field}" must be a number from ${min} to ${max}`);
  return value;
}

function integer(value, field, min, max) {
  if (!Number.isInteger(value)) fail(`"${field}" must be a whole number`);
  return number(value, field, min, max);
}

function vector(value, field, min, max) {
  if (!Array.isArray(value) || value.length !== 3) fail(`"${field}" must be [x, y, z]`);
  return value.map((v, i) => number(v, `${field}[${i}]`, min, max));
}

function range(value, field, min, max, fallback) {
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value) || value.length !== 2) fail(`"${field}" must be [min, max]`);
  const [lo, hi] = value.map((v, i) => number(v, `${field}[${i}]`, min, max));
  if (lo > hi) fail(`"${field}" must be [min, max] with min <= max`);
  return [lo, hi];
}

// A safe absolute URL for an image, resolved against the preset file's own URL.
export function resolveImageUrl(src, baseUrl) {
  if (typeof src !== 'string' || !src.trim() || src.length > 2_000_000) fail('an image needs a "src" string');
  const value = src.trim();
  if (value.startsWith('data:')) {
    if (!DATA_IMAGE.test(value)) fail('data URLs must be images (png, jpeg, gif, webp, avif or svg)');
    return value;
  }
  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    fail(`"${value.slice(0, 80)}" is not a valid image path`);
  }
  if (!['http:', 'https:', 'blob:'].includes(url.protocol)) fail(`"${url.protocol}" image URLs are not allowed`);
  return url.href;
}

function part(raw, field) {
  if (!isObject(raw)) fail(`"${field}" must be an object`);
  if (!SHAPES.includes(raw.shape)) fail(`"${field}.shape" must be one of ${SHAPES.join(', ')}`);
  const out = {
    shape: raw.shape,
    size: vector(raw.size, `${field}.size`, .001, LIMITS.size),
    pos: vector(raw.pos ?? [0, 0, 0], `${field}.pos`, -LIMITS.extent, LIMITS.extent),
    rot: vector(raw.rot ?? [0, 0, 0], `${field}.rot`, -360, 360),
    color: color(raw.color, `${field}.color`),
  };
  if (raw.emissive !== undefined) out.emissive = color(raw.emissive, `${field}.emissive`);
  if (raw.sides !== undefined) out.sides = integer(raw.sides, `${field}.sides`, 3, 32);
  if (raw.pattern !== undefined) {
    const p = raw.pattern;
    if (!isObject(p) || p.type !== 'windows') fail(`"${field}.pattern" must be {"type": "windows", ...}`);
    out.pattern = {
      type: 'windows', rows: integer(p.rows ?? 6, `${field}.pattern.rows`, 1, 40),
      cols: integer(p.cols ?? 4, `${field}.pattern.cols`, 1, 40), lit: number(p.lit ?? .3, `${field}.pattern.lit`, 0, 1),
      color: color(p.color ?? '#2b3343', `${field}.pattern.color`), glow: color(p.glow ?? '#ffd27a', `${field}.pattern.glow`),
    };
  }
  return out;
}

function environment(raw) {
  if (!isObject(raw)) fail('"environment" must be an object');
  if (!Array.isArray(raw.sky) || raw.sky.length !== 2) fail('"environment.sky" must be [zenith, horizon] colors');
  if (!Array.isArray(raw.fog) || raw.fog.length !== 3) fail('"environment.fog" must be [color, near, far]');
  const near = number(raw.fog[1], 'environment.fog[1]', 0, 500);
  const far = number(raw.fog[2], 'environment.fog[2]', near + .1, 1000);
  const sun = raw.sun ?? {};
  if (!isObject(sun)) fail('"environment.sun" must be an object');
  const ambient = raw.ambient ?? ['#ffffff', '#888888', 1];
  if (!Array.isArray(ambient) || ambient.length !== 3) fail('"environment.ambient" must be [sky, ground, intensity]');
  const out = {
    sky: raw.sky.map((c, i) => color(c, `environment.sky[${i}]`)),
    fog: [color(raw.fog[0], 'environment.fog[0]'), near, far],
    ground: color(raw.ground, 'environment.ground'),
    sun: {
      color: color(sun.color ?? '#fff4e5', 'environment.sun.color'),
      intensity: number(sun.intensity ?? 2, 'environment.sun.intensity', 0, 10),
      position: vector(sun.position ?? [6, 12, 4], 'environment.sun.position', -200, 200),
    },
    ambient: [color(ambient[0], 'environment.ambient[0]'), color(ambient[1], 'environment.ambient[1]'),
      number(ambient[2], 'environment.ambient[2]', 0, 10)],
  };
  if (raw.particles !== undefined) {
    const p = raw.particles;
    if (!isObject(p)) fail('"environment.particles" must be an object');
    out.particles = {
      color: color(p.color, 'environment.particles.color'),
      count: integer(p.count ?? 60, 'environment.particles.count', 1, LIMITS.particles),
      radius: number(p.radius ?? 12, 'environment.particles.radius', 1, LIMITS.extent),
      height: number(p.height ?? 3, 'environment.particles.height', .1, 50),
    };
  }
  return out;
}

// Raw parsed JSON -> normalized preset.
export function validatePreset(raw, baseUrl) {
  if (!isObject(raw)) fail('a preset must be a JSON object');
  if (raw.format !== PRESET_FORMAT) fail(`"format" must be "${PRESET_FORMAT}"`);
  if (!Number.isInteger(raw.version) || raw.version < 1) fail('"version" must be a positive whole number');
  if (raw.version > PRESET_VERSION) fail(`this preset needs a newer Mirror Mirror (format version ${raw.version})`);
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) fail('"id" must be 1-40 lowercase letters, digits or dashes');

  if (!isObject(raw.objects)) fail('"objects" must map names to lists of parts');
  const names = Object.keys(raw.objects);
  if (!names.length) fail('"objects" needs at least one object');
  if (names.length > LIMITS.objects) fail(`a preset can define at most ${LIMITS.objects} objects`);
  const objects = {};
  for (const name of names) {
    if (!OBJECT_NAME.test(name)) fail(`object name "${name.slice(0, 40)}" must be lowercase letters, digits or dashes`);
    const parts = raw.objects[name];
    if (!Array.isArray(parts) || !parts.length) fail(`object "${name}" needs a non-empty list of parts`);
    if (parts.length > LIMITS.parts) fail(`object "${name}" has more than ${LIMITS.parts} parts`);
    objects[name] = parts.map((p, i) => part(p, `objects.${name}[${i}]`));
  }
  const known = name => {
    if (!Object.hasOwn(objects, name)) fail(`"${String(name).slice(0, 40)}" is not one of this preset's objects`);
    return name;
  };

  const place = raw.place ?? [];
  if (!Array.isArray(place) || place.length > LIMITS.place) fail(`"place" must be a list of at most ${LIMITS.place}`);
  const places = place.map((p, i) => {
    if (!isObject(p)) fail(`"place[${i}]" must be an object`);
    if (p.object === undefined && p.clear === undefined) fail(`"place[${i}]" needs an object or a clear radius`);
    return {
      object: p.object === undefined ? null : known(p.object),
      pos: vector(p.pos, `place[${i}].pos`, -LIMITS.extent, LIMITS.extent),
      yaw: number(p.yaw ?? 0, `place[${i}].yaw`, -360, 360),
      scale: number(p.scale ?? 1, `place[${i}].scale`, .05, 20),
      clear: number(p.clear ?? 0, `place[${i}].clear`, 0, LIMITS.extent),
    };
  });

  const scatter = raw.scatter ?? [];
  if (!Array.isArray(scatter) || scatter.length > LIMITS.scatter) fail(`"scatter" must be a list of at most ${LIMITS.scatter}`);
  let total = 0;
  const scatters = scatter.map((s, i) => {
    const field = `scatter[${i}]`;
    if (!isObject(s)) fail(`"${field}" must be an object`);
    if (!Array.isArray(s.objects) || !s.objects.length) fail(`"${field}.objects" must be a non-empty list of names`);
    const count = range(s.count, `${field}.count`, 0, LIMITS.scatterTotal).map(Math.round);
    total += count[1];
    const mode = s.mode ?? 'ring';
    if (!['ring', 'roads'].includes(mode)) fail(`"${field}.mode" must be "ring" or "roads"`);
    return {
      objects: s.objects.map(known), count, mode,
      radius: range(s.radius, `${field}.radius`, 0, LIMITS.extent),
      scale: range(s.scale, `${field}.scale`, .05, 20, [1, 1]),
      stretch: range(s.stretch, `${field}.stretch`, .05, 20, [1, 1]),
      spacing: number(s.spacing ?? 1.5, `${field}.spacing`, 0, 50),
      width: number(s.width ?? 0, `${field}.width`, 0, 50),
      keepOffRoads: number(s.keepOffRoads ?? 0, `${field}.keepOffRoads`, 0, 50),
      y: number(s.y ?? 0, `${field}.y`, -10, 50),
      snap: number(s.snap ?? 0, `${field}.snap`, 0, 180),
    };
  });
  if (total > LIMITS.scatterTotal) fail(`scatter can add at most ${LIMITS.scatterTotal} props in total`);

  const view = raw.view ?? {};
  if (!isObject(view)) fail('"view" must be {"yaw", "pitch"}');
  if (raw.tint !== undefined) color(raw.tint, 'tint');
  return {
    id: raw.id,
    name: text(raw.name, 'name', MAX_NAME, true),
    description: text(raw.description, 'description', MAX_TEXT, false),
    tint: raw.tint === undefined ? DEFAULT_TINT : raw.tint.toLowerCase(),
    thumbnail: raw.thumbnail === undefined ? null : resolveImageUrl(raw.thumbnail, baseUrl),
    view: { yaw: number(view.yaw ?? 0, 'view.yaw', -360, 360), pitch: number(view.pitch ?? -4, 'view.pitch', -60, 60) },
    environment: environment(raw.environment),
    objects, place: places, scatter: scatters,
  };
}

// Text of a preset file -> normalized preset. `baseUrl` is where the file came from (relative paths resolve there).
export function parsePreset(textContent, baseUrl) {
  let raw;
  try {
    raw = JSON.parse(textContent);
  } catch (error) {
    fail(`not valid JSON (${error.message})`);
  }
  return validatePreset(raw, baseUrl);
}

export async function loadPreset(url, fetchFn = globalThis.fetch) {
  const response = await fetchFn(url, { cache: 'no-cache' });
  if (!response.ok) fail(`could not load ${url} (HTTP ${response.status})`);
  return parsePreset(await response.text(), response.url || String(url));
}

// Registry entries are a preset folder name ("workshop" -> workshop/preset.json) or a path to a .json file.
export function registryEntryUrl(entry, registryUrl) {
  if (typeof entry !== 'string' || !entry.trim()) fail('registry entries must be folder names or .json paths');
  return new URL(entry.endsWith('.json') ? entry : `${entry}/preset.json`, registryUrl).href;
}

// Loads every preset in the registry. One broken preset is reported in `errors` and skipped instead of blanking the
// whole menu; a duplicate id keeps the first. `background` is the preset shown while nothing is selected (or null).
export async function loadRegistry(registryUrl = REGISTRY_URL, fetchFn = globalThis.fetch) {
  const response = await fetchFn(registryUrl, { cache: 'no-cache' });
  if (!response.ok) fail(`could not load the preset list (HTTP ${response.status})`);
  const registry = JSON.parse(await response.text());
  if (!Array.isArray(registry?.presets)) fail('the preset list needs a "presets" array');
  const base = response.url || String(registryUrl);
  const errors = [];
  const attempt = async entry => {
    try {
      return await loadPreset(registryEntryUrl(entry, base), fetchFn);
    } catch (error) {
      errors.push(`${entry}: ${error.message}`);
      return null;
    }
  };
  const loaded = await Promise.all(registry.presets.map(attempt));
  const presets = [];
  for (const preset of loaded) {
    if (!preset) continue;
    if (presets.some(p => p.id === preset.id)) errors.push(`${preset.id}: duplicate id, skipped`);
    else presets.push(preset);
  }
  const background = registry.background ? await attempt(registry.background) : null;
  return { presets, background, errors };
}
