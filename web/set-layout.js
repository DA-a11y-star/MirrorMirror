// Where a preset's props go. Pure functions (no three.js), so the placement rules test without a browser.
// The scene is centered on the viewer, who stands at the origin; landmarks are fixed and scatter is random, so each
// visit arranges the set differently.

// Seeded PRNG (mulberry32). The landing page seeds it from the clock; tests seed it with constants.
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = ([lo, hi], k) => lo + (hi - lo) * k;
const ATTEMPTS_PER_PROP = 30;

// -> [{object, x, y, z, yaw (degrees), scale, stretch, landmark}] for a normalized preset (see presets.js).
export function scatterLayout(preset, rand) {
  const landmarks = preset.place.filter(p => p.object).map(p => ({
    object: p.object, x: p.pos[0], y: p.pos[1], z: p.pos[2], yaw: p.yaw, scale: p.scale, stretch: 1, landmark: true,
  }));
  const clears = preset.place.filter(p => p.clear > 0).map(p => ({ x: p.pos[0], z: p.pos[2], r: p.clear }));
  const props = [];
  for (const s of preset.scatter) {
    const want = s.count[0] + Math.floor(rand() * (s.count[1] - s.count[0] + 1));
    let made = 0;
    for (let tries = 0; made < want && tries < want * ATTEMPTS_PER_PROP; tries++) {
      let x;
      let z;
      let yaw;
      if (s.mode === 'roads') {
        // Along one of the two roads that cross at the origin, in a lane, facing along the road.
        const along = (rand() < .5 ? -1 : 1) * lerp(s.radius, rand());
        const lane = (rand() < .5 ? -1 : 1) * s.width / 4;
        if (rand() < .5) [x, z, yaw] = [along, lane, lane > 0 ? 0 : 180];
        else [x, z, yaw] = [lane, along, lane > 0 ? 90 : -90];
      } else {
        // Uniform over the ring's area, so the far edge isn't sparser than the near one.
        const r = Math.sqrt(s.radius[0] ** 2 + rand() * (s.radius[1] ** 2 - s.radius[0] ** 2));
        const angle = rand() * Math.PI * 2;
        [x, z, yaw] = [Math.cos(angle) * r, Math.sin(angle) * r, rand() * 360];
        if (s.snap) yaw = Math.round(yaw / s.snap) * s.snap;
      }
      if (s.keepOffRoads && (Math.abs(x) < s.keepOffRoads || Math.abs(z) < s.keepOffRoads)) continue;
      if (clears.some(c => Math.hypot(x - c.x, z - c.z) < c.r)) continue;
      if (props.some(p => Math.hypot(x - p.x, z - p.z) < (p.spacing + s.spacing) / 2)) continue;
      props.push({
        object: s.objects[Math.floor(rand() * s.objects.length)], x, y: s.y, z, yaw,
        scale: lerp(s.scale, rand()), stretch: lerp(s.stretch, rand()), spacing: s.spacing, landmark: false,
      });
      made++;
    }
  }
  return [...landmarks, ...props];
}
