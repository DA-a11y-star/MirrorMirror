import * as THREE from 'three';

// Streets for a set whose model has bare ground: which of it is road, a pavement strip along the buildings, the middle
// line of every road, and a texture with pavement, kerbs and lane markings to lay over it. Everything except `roadMesh`
// is pure (no GPU, no DOM), so it runs and tests in Node. Lengths are metres; x and z are world coordinates.

export const SIDEWALK = 1.2; // metres of pavement between a building and the asphalt

const chamfer = (dist, w, d) => { // two-pass distance transform of `dist` (0 on the sources, 1e9 elsewhere), in cells
  const at = (x, z) => z * w + x;
  const relax = (x, z, nx, nz, step) => {
    if (nx < 0 || nz < 0 || nx >= w || nz >= d) return;
    dist[at(x, z)] = Math.min(dist[at(x, z)], dist[at(nx, nz)] + step);
  };
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) { relax(x, z, x - 1, z, 1); relax(x, z, x, z - 1, 1); relax(x, z, x - 1, z - 1, 1.414); relax(x, z, x + 1, z - 1, 1.414); }
  for (let z = d - 1; z >= 0; z--) for (let x = w - 1; x >= 0; x--) { relax(x, z, x + 1, z, 1); relax(x, z, x, z + 1, 1); relax(x, z, x + 1, z + 1, 1.414); relax(x, z, x - 1, z + 1, 1.414); }
};

// Buildings, ground and roads on one grid, from a `buildClearance` map and its `groundLevels`. Blobs of fewer than
// `minBuilding` square metres (lamp posts, signs, railings) are not buildings and are ignored, so the road runs past them.
// -> {x0, z0, w, d, cell, blocked (1 = building), levels, dist (metres from the nearest building's edge, 0 inside one),
//     walk (the pavement strip's width at each cell), road (metres from the edge of the asphalt, 0 off it)}. Asphalt is
//     road-level ground at least `walk` from a building. The strip is `sidewalk` wide, but at most `narrow` (0.3) of the width of
//     the open ground between the buildings there (measured as the widest clearance within 3 m), so a narrow road keeps
//     its asphalt instead of turning to pavement, and the roads stay joined at their junctions.
export function roadField(clearance, levels, { minBuilding = 6, sidewalk = SIDEWALK, narrow = 0.3 } = {}) {
  const { x0, z0, w, d, cell, bits, low } = clearance;
  const blocked = new Uint8Array(w * d);
  // Solid where anything is: except where only something overhead is (an overpass or a walkway), over road-level ground,
  // which is still open road underneath.
  for (let i = 0; i < w * d; i++) blocked[i] = bits[i] && !(low[i] > 0 && levels[i] === 1) ? 1 : 0;

  const seen = new Uint8Array(w * d), stack = [];
  for (let start = 0; start < w * d; start++) {
    if (!blocked[start] || seen[start]) continue;
    const blob = [start];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const at = stack.pop(), x = at % w, z = (at - x) / w;
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        if (nx < 0 || nz < 0 || nx >= w || nz >= d) continue;
        const next = nz * w + nx;
        if (!blocked[next] || seen[next]) continue;
        seen[next] = 1;
        blob.push(next);
        stack.push(next);
      }
    }
    if (blob.length * cell * cell < minBuilding) for (const at of blob) blocked[at] = 0;
  }

  const dist = new Float32Array(w * d);
  for (let i = 0; i < w * d; i++) dist[i] = blocked[i] ? 0 : 1e9;
  chamfer(dist, w, d);
  for (let i = 0; i < w * d; i++) dist[i] = blocked[i] ? 0 : Math.max(0, dist[i] * cell - cell / 2); // to the building's edge, not its cell centre

  const radius = Math.ceil(3 / cell); // the widest clearance within 3 m, as two sliding-window maxima (square window)
  const rows = new Float32Array(w * d), wide = new Float32Array(w * d);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, x - radius); k <= Math.min(w - 1, x + radius); k++) m = Math.max(m, dist[z * w + k]); rows[z * w + x] = m; }
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, z - radius); k <= Math.min(d - 1, z + radius); k++) m = Math.max(m, rows[k * w + x]); wide[z * w + x] = m; }
  const walk = new Float32Array(w * d);
  for (let i = 0; i < w * d; i++) walk[i] = Math.min(sidewalk, narrow * wide[i]);

  const road = new Float32Array(w * d);
  for (let i = 0; i < w * d; i++) road[i] = !blocked[i] && levels[i] === 1 && dist[i] >= walk[i] ? 1e9 : 0;
  chamfer(road, w, d);
  for (let i = 0; i < w * d; i++) road[i] = road[i] > 0 ? Math.max(0, road[i] * cell - cell / 2) : 0;
  return { x0, z0, w, d, cell, blocked, levels, dist, walk, road };
}

// A field value (`grid` is field.dist or field.road) at a world point, bilinear between cell centres.
export function sampleField(field, grid, x, z) {
  const { x0, z0, w, d, cell } = field;
  const fx = (x - x0) / cell - 0.5, fz = (z - z0) / cell - 0.5;
  const ix = Math.max(0, Math.min(w - 2, Math.floor(fx))), iz = Math.max(0, Math.min(d - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - ix)), tz = Math.max(0, Math.min(1, fz - iz));
  const a = grid[iz * w + ix], b = grid[iz * w + ix + 1], c = grid[(iz + 1) * w + ix], e = grid[(iz + 1) * w + ix + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
}

// The middle lines of the roads, as points: the asphalt's ridge (cells at least as far from its edge as all eight
// neighbours), at least `minHalf` from the edge, smoothed over 1 m. Each point has `half` (half the asphalt's width there),
// `tx, tz` (the unit direction of the road, a line so the sign is fixed: tx > 0, or tz > 0 when tx = 0) and `line`
// (0 to 1: near 1 on a straight road, low at a junction or a blob, where the direction means little).
export function roadSkeleton(field, { minHalf = 1.3, maxHalf = 9, radius = 4 } = {}) {
  const { x0, z0, w, d, cell, road } = field;
  const ridge = [];
  for (let z = 1; z < d - 1; z++) {
    for (let x = 1; x < w - 1; x++) {
      const v = road[z * w + x];
      if (v < minHalf || v > maxHalf) continue;
      let top = true;
      for (let dz = -1; dz <= 1 && top; dz++) for (let dx = -1; dx <= 1; dx++) if ((dx || dz) && road[(z + dz) * w + x + dx] > v + 1e-4) { top = false; break; }
      if (top) ridge.push({ x: x0 + (x + 0.5) * cell, z: z0 + (z + 0.5) * cell, half: v });
    }
  }
  const bucket = 4, buckets = new Map();
  const key = (x, z) => `${Math.floor(x / bucket)},${Math.floor(z / bucket)}`;
  for (const p of ridge) { const k = key(p.x, p.z); (buckets.get(k) ?? buckets.set(k, []).get(k)).push(p); }
  const near = (p, r) => {
    const out = [];
    for (let gx = Math.floor((p.x - r) / bucket); gx <= Math.floor((p.x + r) / bucket); gx++) {
      for (let gz = Math.floor((p.z - r) / bucket); gz <= Math.floor((p.z + r) / bucket); gz++) {
        for (const q of buckets.get(`${gx},${gz}`) ?? []) if (Math.hypot(q.x - p.x, q.z - p.z) <= r) out.push(q);
      }
    }
    return out;
  };
  return ridge.map(p => {
    const around = near(p, radius);
    const mx = around.reduce((s, q) => s + q.x, 0) / around.length, mz = around.reduce((s, q) => s + q.z, 0) / around.length;
    let sxx = 0, szz = 0, sxz = 0;
    for (const q of around) { sxx += (q.x - mx) ** 2; szz += (q.z - mz) ** 2; sxz += (q.x - mx) * (q.z - mz); }
    const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    let tx = Math.cos(angle), tz = Math.sin(angle);
    if (tx < -1e-9 || (Math.abs(tx) <= 1e-9 && tz < 0)) { tx = -tx; tz = -tz; }
    const spread = Math.sqrt(Math.max(0, (sxx - szz) ** 2 + 4 * sxz ** 2));
    const total = sxx + szz;
    const close = near(p, 1);
    return {
      x: close.reduce((s, q) => s + q.x, 0) / close.length, z: close.reduce((s, q) => s + q.z, 0) / close.length,
      half: p.half, tx, tz, line: total > 1e-9 ? spread / total : 0,
    };
  });
}

// Roads that lead nowhere are joined. The model's road-level ground is in separate pieces with bare ground between them, so
// the asphalt pieces (`field.road` over half a metre, at least `minArea` square metres) are linked into one network. Each
// piece searches outward (a shortest-path search on a `node`-metre grid) for the other pieces it can reach on bare ground
// that stays `width / 2 + 0.4` clear of every building and off the raised platforms, going around buildings and preferring
// open ground, up to `maxBridge` metres of road. Only the shortest links that connect everything are kept (a minimum
// spanning tree). A link is a road `width` wide with a pavement strip each side, simplified to straight stretches and
// written into a copy of the ground levels, so roadField sees it like any other road.
// -> {levels, bridges: [{points: [[x, z], ...], length}]}
export function connectRoads(field, { width = 3.2, maxBridge = 70, minArea = 5, sidewalk = SIDEWALK, node = 1 } = {}) {
  const { x0, z0, w, d, cell, road, blocked, levels } = field;
  const label = new Int32Array(w * d).fill(-1), pieces = [];
  const stack = [];
  for (let start = 0; start < w * d; start++) {
    if (road[start] <= 0.5 || label[start] >= 0) continue;
    const id = pieces.length, cells = [];
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const at = stack.pop();
      cells.push(at);
      const x = at % w, z = (at - x) / w;
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        if (nx < 0 || nz < 0 || nx >= w || nz >= d) continue;
        const next = nz * w + nx;
        if (road[next] > 0.5 && label[next] < 0) { label[next] = id; stack.push(next); }
      }
    }
    pieces.push(cells);
  }
  const keep = [];
  pieces.forEach((cells, id) => { if (cells.length * cell * cell >= minArea) keep.push(id); });
  const slot = new Map(keep.map((id, k) => [id, k])); // piece id -> index among the kept pieces

  // The search grid: a node is open where a road could go (and always inside a piece of asphalt).
  const nw = Math.ceil(w * cell / node), nd = Math.ceil(d * cell / node);
  const open = new Uint8Array(nw * nd), owner = new Int16Array(nw * nd).fill(-1), nearness = new Float32Array(nw * nd);
  for (let nz = 0; nz < nd; nz++) {
    for (let nx = 0; nx < nw; nx++) {
      const x = x0 + (nx + 0.5) * node, z = z0 + (nz + 0.5) * node;
      const ix = Math.min(w - 1, Math.floor((x - x0) / cell)), iz = Math.min(d - 1, Math.floor((z - z0) / cell));
      const at = iz * w + ix, k = nz * nw + nx;
      const piece = label[at] >= 0 ? slot.get(label[at]) : undefined;
      if (piece !== undefined) { owner[k] = piece; open[k] = 1; continue; }
      const away = sampleField(field, field.dist, x, z);
      nearness[k] = away;
      if (!blocked[at] && levels[at] !== 3 && away >= width / 2 + 0.4) open[k] = 1;
    }
  }
  const heap = []; // binary min-heap of [cost, node]
  const push = item => { heap.push(item); let i = heap.length - 1; while (i > 0) { const up = (i - 1) >> 1; if (heap[up][0] <= heap[i][0]) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const links = new Map(); // "i,j" -> the best link between pieces i < j
  keep.forEach((_, from) => {
    const cost = new Float64Array(nw * nd).fill(Infinity), before = new Int32Array(nw * nd).fill(-1); // 64-bit: it is compared with the heap's doubles
    heap.length = 0;
    for (let k = 0; k < nw * nd; k++) if (owner[k] === from) { cost[k] = 0; push([0, k]); }
    while (heap.length) {
      const [so_far, at] = pop();
      if (so_far > cost[at]) continue;
      if (owner[at] >= 0 && owner[at] !== from) { // reached another piece: a link, and not a way through it
        const lo = Math.min(from, owner[at]), hi = Math.max(from, owner[at]), key = `${lo},${hi}`;
        if (!links.has(key) || links.get(key).length > so_far) {
          const path = [];
          for (let k = at; k >= 0; k = before[k]) path.push([x0 + ((k % nw) + 0.5) * node, z0 + (Math.floor(k / nw) + 0.5) * node]);
          links.set(key, { i: lo, j: hi, length: so_far, path: path.reverse() });
        }
        continue;
      }
      const x = at % nw, z = (at - x) / nw;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const mx = x + dx, mz = z + dz;
          if (mx < 0 || mz < 0 || mx >= nw || mz >= nd) continue;
          const next = mz * nw + mx;
          if (!open[next]) continue;
          if (dx && dz && (!open[z * nw + mx] || !open[mz * nw + x])) continue; // no cutting a corner of a building
          const step = Math.hypot(dx, dz) * node * (owner[next] < 0 && nearness[next] < 3.5 ? 1.6 : 1); // keep to open ground where possible
          const total = so_far + step;
          if (total < cost[next] && total <= maxBridge * 1.6) { cost[next] = total; before[next] = at; push([total, next]); }
        }
      }
    }
  });
  const parent = keep.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const chosen = [...links.values()].sort((p, q) => p.length - q.length).filter(link => {
    const a = find(link.i), b = find(link.j);
    if (a === b) return false;
    parent[a] = b;
    return true;
  });

  // Straight stretches only: drop points that lie within `tolerance` of the line between their neighbours (Douglas-Peucker).
  const simplify = (points, tolerance = 0.8) => {
    if (points.length < 3) return points;
    const [a, b] = [points[0], points.at(-1)];
    let far = 0, at = 0;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    points.forEach((p, i) => {
      const away = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
      if (away > far) { far = away; at = i; }
    });
    return far <= tolerance ? [a, b] : [...simplify(points.slice(0, at + 1), tolerance).slice(0, -1), ...simplify(points.slice(at), tolerance)];
  };
  const out = Uint8Array.from(levels);
  const bridges = chosen.map(link => {
    const points = simplify(link.path);
    const reach = width / 2 + sidewalk;
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, az] = points[k], [bx, bz] = points[k + 1];
      const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / cell)), ix1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + reach - x0) / cell));
      const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / cell)), iz1 = Math.min(d - 1, Math.floor((Math.max(az, bz) + reach - z0) / cell));
      const sx = bx - ax, sz = bz - az, len2 = sx * sx + sz * sz;
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const px = x0 + (ix + 0.5) * cell, pz = z0 + (iz + 0.5) * cell;
          const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * sx + (pz - az) * sz) / len2)) : 0;
          const away = Math.hypot(px - (ax + sx * t), pz - (az + sz * t));
          const at = iz * w + ix;
          if (blocked[at] || out[at] === 3) continue;
          if (away <= width / 2) out[at] = 1;
          else if (away <= reach && out[at] === 0) out[at] = 2;
        }
      }
    }
    return { points, length: link.length };
  });
  return { levels: out, bridges };
}

// Where roads meet: points on the road middle lines (`skeleton`) with three or more roads leaving them, found by looking at
// the middle line's points on a circle of `radius` around each and counting the separate groups of them. Candidates closer
// than `merge` metres to each other are one junction, at their average. -> [{x, z, arms}]
export function findJunctions(skeleton, { radius = 5, merge = 8, minArms = 3 } = {}) {
  const bucket = 4, buckets = new Map();
  const key = (x, z) => `${Math.floor(x / bucket)},${Math.floor(z / bucket)}`;
  for (const p of skeleton) { const k = key(p.x, p.z); (buckets.get(k) ?? buckets.set(k, []).get(k)).push(p); }
  const candidates = [];
  for (const p of skeleton) {
    const angles = [];
    for (let gx = Math.floor((p.x - radius - 1) / bucket); gx <= Math.floor((p.x + radius + 1) / bucket); gx++) {
      for (let gz = Math.floor((p.z - radius - 1) / bucket); gz <= Math.floor((p.z + radius + 1) / bucket); gz++) {
        for (const q of buckets.get(`${gx},${gz}`) ?? []) {
          const r = Math.hypot(q.x - p.x, q.z - p.z);
          if (r >= radius - 1 && r <= radius + 1) angles.push(Math.atan2(q.z - p.z, q.x - p.x));
        }
      }
    }
    if (angles.length < minArms) continue;
    angles.sort((a, b) => a - b);
    let arms = 0;
    for (let i = 0; i < angles.length; i++) {
      const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
      if (next - angles[i] > 0.7) arms++; // a gap of 40 degrees or more separates two roads
    }
    if (arms >= minArms) candidates.push({ x: p.x, z: p.z, arms });
  }
  candidates.sort((a, b) => b.arms - a.arms);
  const groups = [];
  for (const c of candidates) {
    const group = groups.find(g => Math.hypot(g.x - c.x, g.z - c.z) < merge);
    if (group) { group.members.push(c); group.arms = Math.max(group.arms, c.arms); } else groups.push({ x: c.x, z: c.z, arms: c.arms, members: [c] });
  }
  return groups.map(g => ({
    x: g.members.reduce((s, m) => s + m.x, 0) / g.members.length, z: g.members.reduce((s, m) => s + m.z, 0) / g.members.length, arms: g.arms,
  }));
}

const hex = value => [(value >> 16) & 255, (value >> 8) & 255, value & 255];
export const ROAD_COLORS = { asphalt: 0x14141c, pavement: 0x3b3a4d, joint: 0x2b2a3a, kerb: 0x5d5b75, stripe: 0xe9e9f3 };

// The texture for the roads, a pixel every `pixel` metres, covering the field. Buildings, bare ground and raised platforms
// are transparent (alpha 0), so the model's own surface shows through there. Plaza-level ground is pavement (joints
// every 1.2 m); road-level ground is pavement within `walk` of a building and asphalt beyond it, with a lighter kerb
// along the asphalt's edge, a thin solid white line just inside the kerb, and a dashed white line down the middle of every
// road wide enough for two lanes (`half` of at least `twoLanes`). -> {width, height, data (RGBA), x0, z0, pixel}
export function paintRoads(field, skeleton, { pixel = 0.1, kerb = 0.3, edge = 0.14, twoLanes = 2.5 } = {}) {
  const { x0, z0, w, d, cell, blocked, levels, dist, walk, road } = field;
  const width = Math.ceil(w * cell / pixel), height = Math.ceil(d * cell / pixel);
  const data = new Uint8ClampedArray(width * height * 4);
  const color = Object.fromEntries(Object.entries(ROAD_COLORS).map(([k, v]) => [k, hex(v)]));
  for (let py = 0; py < height; py++) {
    const z = z0 + (py + 0.5) * pixel;
    for (let px = 0; px < width; px++) {
      const x = x0 + (px + 0.5) * pixel;
      const cx = Math.min(w - 1, Math.floor((x - x0) / cell)), cz = Math.min(d - 1, Math.floor((z - z0) / cell));
      const level = levels[cz * w + cx];
      if (blocked[cz * w + cx] || level === 0 || level === 3) continue;
      const noise = ((px * 73856093) ^ (py * 19349663)) & 15;
      const joint = (x - x0) % 1.2 < 0.04 || (z - z0) % 1.2 < 0.04;
      let rgb = color.pavement;
      if (level === 2 || sampleField(field, dist, x, z) < walk[cz * w + cx]) rgb = joint ? color.joint : color.pavement;
      else { // asphalt: a lighter kerb at its edge, then a thin solid white line just inside it
        const inside = sampleField(field, road, x, z);
        rgb = inside < kerb ? color.kerb : inside < kerb + edge ? color.stripe : color.asphalt;
      }
      const out = (py * width + px) * 4;
      data[out] = rgb[0] + noise * 0.4; data[out + 1] = rgb[1] + noise * 0.4; data[out + 2] = rgb[2] + noise * 0.5; data[out + 3] = 255;
    }
  }
  const DASH = 2.5, PERIOD = 5, REACH = 0.1; // the line is 0.2 m wide: a stamp of radius REACH at every middle-line point
  for (const p of skeleton) {
    if (p.half < twoLanes || p.line < 0.85) continue;
    const along = p.x * p.tx + p.z * p.tz;
    if (((along % PERIOD) + PERIOD) % PERIOD >= DASH) continue;
    for (let dz = -REACH; dz <= REACH; dz += pixel / 2) {
      for (let dx = -REACH; dx <= REACH; dx += pixel / 2) {
        const px = Math.floor((p.x + dx - x0) / pixel), py = Math.floor((p.z + dz - z0) / pixel);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const out = (py * width + px) * 4;
        if (!data[out + 3]) continue;
        data[out] = color.stripe[0]; data[out + 1] = color.stripe[1]; data[out + 2] = color.stripe[2];
      }
    }
  }
  return { width, height, data, x0, z0, pixel };
}

// The painted roads as a flat mesh just above the ground (2 cm, pulled forward in depth so it never flickers against it).
export function roadMesh(painted) {
  const texture = new THREE.DataTexture(painted.data, painted.width, painted.height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  const sizeX = painted.width * painted.pixel, sizeZ = painted.height * painted.pixel;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(sizeX, sizeZ),
    new THREE.MeshStandardMaterial({
      map: texture, alphaTest: 0.5, roughness: 0.85, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  );
  mesh.name = 'roads';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(painted.x0 + sizeX / 2, 0.02, painted.z0 + sizeZ / 2);
  mesh.receiveShadow = false;
  mesh.userData.scenery = true;
  return mesh;
}
