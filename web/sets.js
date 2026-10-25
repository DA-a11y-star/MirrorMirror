import { chunkScenery, fitScenery, prepareScenery } from './scenery.js';

// The worlds the app can show: a set is its model file plus the look around it. Pick one with ?set=<id>.
// Only the first city exists so far; there is no in-app switching yet.
export const SETS = {
  workshop: { name: 'Workshop' }, // the plain starting room: no model, the default floor and blocks
  cyberpunk: {
    name: 'Cyberpunk city',
    model: 'assets/cyberpunk/cyberpunk_city_-_1.glb',
    // The model is a miniature (9 m wide, 3 m towers, streets 1 m wide), so it is scaled up until it is a city around
    // you: at 15x the towers are 46 m (a modern high-rise next to a 1.7 m person), the streets 15 m and the whole
    // thing 138 m across. Measured at that scale: plazas of ~15 m radius exist along the north edge, the rest is dense.
    scale: 15,
    center: [0, 0],
    // The streets are not at the model's lowest point. Measured, its ground has two levels, the roads at 0.0603 model units
    // and the plazas at 0.0692 (13 cm higher; a few platforms are higher still, and much of the area has no ground at all).
    // The model is lowered by 0.0692 x scale (1.04 m) so the plazas are at y = 0, where avatars and blocks stand (the roads
    // sit 13 cm under it; the painted road surface covers both). Without it you stood a metre inside the ground.
    floor: 0.0692,
    // Where the blocks and the two spawns go: the open street nearest the middle of the model. Found by scanning the
    // scaled model for a spot with no structure above 0.9 m anywhere in a 7 x 11 m box (nothing to stand inside or
    // under: no building, no overpass) and street-level ground. It is 14 m east of the centre, with streets open 19 m
    // to the north and 9 m to the south and buildings on both sides. Offsets the default spawns and the blocks.
    workspace: [14, -1],
    // Rendering budget. The model is split into `chunk`-metre cells so the camera can skip what is out of view, and the
    // far plane is the fog's end, so nothing beyond the haze is ever drawn. Scenery casts and receives no shadows: it is
    // lit by its own neon, and a shadow pass over a 138 m city would cost more than it shows.
    bound: 90, // half size of the square avatars may walk and fly in (the model is 138 x 132 m)
    ceiling: 60, // the towers are 46 m; flying above them is the best view
    chunk: 64,
    shadows: { castShadow: false, receiveShadow: false },
    // Night: dark sky, violet haze, cool moonlight and a pink fill, so the model's neon (emissive) materials carry it.
    environment: {
      background: 0x0a0818, fog: [0x140b2a, 25, 110], hemisphere: [0x9b8cff, 0x2b1a55, 2.0],
      sun: [0xb8c4ff, 1.6], fill: [0xff5ad8, 1.2], floor: 0x0d0b1a, grid: false,
      floorY: -0.2, // just below the streets, so the plain floor never fights the model's ground
      floorSize: 400, // the plain room's floor is 60 m; enlarged so its edge never shows inside the fog
    },
    // Decoration around the city (web/props.js). Every laptop plans the same ones from the model alone.
    props: {
      // The ground is painted from the model's own: asphalt, a pavement strip along the buildings (at most 30% of the open
      // width, so narrow roads stay roads), kerbs, white lines. Pieces of road that stop at a gap are joined up to 70 m away.
      roads: { sidewalk: 1.2, join: { width: 3.2, maxBridge: 70 } },
      // Floating lights over the places where roads meet.
      junctions: { height: 7.5 },
      cars: {
        model: 'assets/cyberpunk/car_2_detailed.glb', length: 3.8, // metres: a compact car, the roads are narrow
        road: { max: 20, gap: [9, 17] }, // driving the roads in lanes, 9-17 m behind the next one going the same way
        air: { max: 40, spacing: 14, altitudes: [4, 8, 13, 19, 27] }, // hovering at different levels over the built-up part
        avoid: 10, // keep this many metres around the blocks free
        chunk: 50, // cars are instanced per 50 m square, so squares out of view or past the far plane cost nothing
      },
      // Movable street lamps (9.8 m tall) on the pavement beside the road, about 17-24 m apart, near the blocks (a shared
      // object costs sync traffic and the scene is capped at 64, so only the first area gets them).
      lamps: { gap: 17, max: 24, radius: 70 },
      // Eve is about the avatar's size and hovers; Wall-E (built from primitives, there is no model) is a little smaller.
      // Offsets are from the workspace; both stand west of the blocks facing them.
      eve: { model: 'assets/cyberpunk/eve_from_wall-e.glb', height: 1.5, hover: 0.35, offset: [-2.0, -0.6] },
      walle: { height: 1.1, offset: [-2.0, 0.8] },
      // One airship (130k triangles, merged into a few meshes) on a level circle around the spawn, just inside the draw
      // distance (the fog ends at 110 m), above the tallest building (46 m), one slow lap every five minutes.
      airship: {
        model: 'assets/cyberpunk/airship.glb', length: 32, radius: 95, height: 50, period: 300,
        yawOffset: 0, // the nose is assumed to be +x; if it flies backwards, set this to Math.PI
      },
    },
    credit: '"Cyberpunk City - #1" by born2012 (https://sketchfab.com/born2012), CC BY 4.0. Cars: "Car 2 detailed" by iskandar1ch; Eve: "Eve from Wall-E" by ehockett; "Airship" by Shinsin (all Sketchfab, CC BY 4.0)',
  },
  'japanese-garden': {
    name: 'Japanese Garden',
    model: 'assets/japanese-garden/kyles-japanese_garden.glb',
    // A 29 m square plot at real-world size (the house is about 12 m wide), hung 20 m below the origin with rocks that
    // reach 1.4 m below the lawn. `floor` is the lawn's height in the model (-19.95 m, plus 1 cm so the lawn sits just
    // above the room floor instead of fighting it). The plot is dense, so `center` puts the open lawn west of the pond
    // (3 m of clear ground, measured by raycasting the model) on the origin, where the blocks and both spawns are.
    scale: 1,
    center: [7.75, 0.8],
    floor: -19.96,
    shadows: { castShadow: true },
    // A bright, soft morning: the model's pastel flat colors carry it.
    environment: {
      background: 0xa9cfee, fog: [0xdcebf3, 35, 120], hemisphere: [0xe4f0ff, 0x86b585, 0.9],
      sun: [0xfff1d8, 1.1], floor: 0x86cc8a, grid: false,
    },
    credit: '"KyleS-Japanese Garden" by ksayavanh2023 (https://sketchfab.com/ksayavanh2023), CC BY 4.0',
  },
  'chinese-city': {
    name: 'Chinese City',
    model: 'assets/chinese-city/low_poly_chinese_city.glb',
    // A walled town of about 35 x 33 m with gates on four sides, a main avenue (along z, the axis the two spawns use) and
    // a cross street. At 1x the streets are only 2.7 m wide, too tight for the starter blocks (1.7 m) and two users, so it
    // is built at 2x: streets 5.4 m, buildings about 9 m. `center` puts the middle of the crossroads (20.5, 28 in the
    // model) on the origin, and `floor` is the paving's height in the model (0.01), so the street sits 2 cm above the room
    // floor instead of fighting it.
    scale: 2,
    center: [0, 9],
    floor: 0,
    shadows: { castShadow: true },
    // A dragon circles above the town (dragon.js): its lowest flight clears the tallest roof (9.2 m) by a few metres.
    dragon: { center: [0, 0], radius: [22, 34], height: [13, 19], speed: 8 },
    // Warm afternoon. The model's ground plane was removed, so the room floor shows through the courtyards: packed earth.
    environment: {
      background: 0xb9d6ec, fog: [0xe9e2d4, 45, 130], hemisphere: [0xfff3df, 0x8c7c62, 1.3],
      sun: [0xfff0d6, 1.7], floor: 0xa89a80, grid: false,
    },
    credit: '"Low poly Chinese city" by smooth998 (https://sketchfab.com/smooth998), CC BY 4.0',
  },
};

// Loads the set's model with the given GLTFLoader, adds it to `scene` as non-interactive scenery and resolves with
// its root, or null for a set without a model. The loader is passed in so this file needs nothing but three.
export async function loadSetModel(set, scene, loader) {
  if (!set.model) return null;
  const gltf = await loader.loadAsync(set.model);
  const root = gltf.scene;
  root.name = 'scenery';
  fitScenery(root, { scale: set.scale, center: set.center, floor: set.floor });
  if (set.chunk) chunkScenery(root, set.chunk);
  prepareScenery(root, set.shadows);
  scene.add(root);
  return root;
}
