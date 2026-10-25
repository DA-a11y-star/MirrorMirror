// The relay carries a render recipe, never audio, transcripts, prompts, or model requests.
export const MAX_OBJECTS = 64;
export const MAX_SCENE_LIST = 256; // most `deleted` tombstones or `acks` a single scene message may carry
const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
const rotation = q => finite(q, 4) && q.reduce((sum, v) => sum + v*v, 0) > 1e-8;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 100;

export function validAssembly(spec) {
  if (!spec || spec.version !== 1 || !id(spec.id) || typeof spec.name !== 'string' || spec.name.length > 100 ||
      !finite(spec.position, 3) || !rotation(spec.quaternion) || !Array.isArray(spec.parts) ||
      !spec.parts.length || spec.parts.length > 40) return false;
  const ids = new Set();
  for (const part of spec.parts) {
    if (!part || !id(part.id) || ids.has(part.id) || !['box', 'sphere', 'cylinder', 'cone'].includes(part.shape) ||
        !finite(part.size, 3) || !part.size.every(v => v > 0 && v <= 10) || !finite(part.position, 3) ||
        !rotation(part.quaternion) || typeof part.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(part.color)) return false;
    ids.add(part.id);
  }
  return true;
}

// Explicitly whitelist fields, even when the generating service returns extra metadata.
export function renderSpec(spec) {
  if (!validAssembly(spec)) throw new Error('Invalid object specification');
  return {
    version: 1, id: spec.id, name: spec.name, position: [...spec.position], quaternion: [...spec.quaternion],
    parts: spec.parts.map(p => ({ id: p.id, shape: p.shape, size: [...p.size], position: [...p.position],
      quaternion: [...p.quaternion], color: p.color })),
  };
}

// An assembly's pose without its recipe: what a steady-state host scene carries for objects peers already have.
export function validAssemblyTransform(obj) {
  return !!obj && obj.kind === 'assembly' && id(obj.id) &&
    finite(obj.pos, 3) && rotation(obj.quat) && finite(obj.scale, 3) && obj.scale.every(v => v > 0 && v <= 10);
}

export function validAssemblyObject(obj) {
  return validAssemblyTransform(obj) && validAssembly(obj.spec) && obj.id === obj.spec.id;
}
