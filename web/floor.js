// Walkable surfaces of a world, as pure functions (no three.js). The ground disc is y = 0, but some props are floors
// you stand on: the workshop's deck and barn floor (0.3 m thick), the city's roads, the mall's paths. Without this the
// avatar's feet sink into them.
const MIN_TOP = 0.03; // m, thinner than this isn't worth stepping up for
const MAX_TOP = 0.9; // m, taller than this is a wall or a table, not a floor
const MIN_SIDE = 2; // m, a floor is wide in both directions

// Boxes in the preset that are floors, placed the way set-scene.js places every copy of every object.
// `layout` is what scatterLayout returned: [{object, x, y, z, yaw (degrees), scale, stretch}].
export function floorRects(preset, layout) {
  const rects = [];
  for (const item of layout) {
    const yaw = (item.yaw * Math.PI) / 180;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (const part of preset.objects[item.object] ?? []) {
      if (part.shape !== 'box' || part.rot.some(r => r !== 0)) continue;
      const sy = item.scale * item.stretch;
      const top = item.y + (part.pos[1] + part.size[1] / 2) * sy;
      const hx = (part.size[0] * item.scale) / 2;
      const hz = (part.size[2] * item.scale) / 2;
      if (top < MIN_TOP || top > MAX_TOP || hx * 2 < MIN_SIDE || hz * 2 < MIN_SIDE) continue;
      const px = part.pos[0] * item.scale;
      const pz = part.pos[2] * item.scale;
      // Y rotation by yaw: x' = x cos + z sin, z' = -x sin + z cos
      rects.push({ cx: item.x + px * cos + pz * sin, cz: item.z - px * sin + pz * cos, hx, hz, cos, sin, top });
    }
  }
  return rects;
}

// -> (x, z) => height of the floor there: the highest surface under the point, else 0.
export function makeFloorAt(rects) {
  return (x, z) => {
    let height = 0;
    for (const r of rects) {
      if (r.top <= height) continue;
      const dx = x - r.cx;
      const dz = z - r.cz;
      const lx = dx * r.cos - dz * r.sin; // into the rectangle's own frame
      const lz = dx * r.sin + dz * r.cos;
      if (Math.abs(lx) <= r.hx && Math.abs(lz) <= r.hz) height = r.top;
    }
    return height;
  };
}
