import { fitScenery, prepareScenery } from './scenery.js';

// The worlds the app can show: a set is its model file plus the look around it. Pick one with ?set=<id>.
// Only the first city exists so far; there is no in-app switching yet.
export const SETS = {
  workshop: { name: 'Workshop' }, // the plain starting room: no model, the default floor and blocks
  cyberpunk: {
    name: 'Cyberpunk city',
    model: 'assets/cyberpunk/cyberpunk_city_-_1.glb',
    // The model is a miniature: 9 m wide with 3 m towers and streets only 1 m wide, far too tight to walk through
    // at any scale (measured: the widest open ground is ~2 m across at 1x, ~9 m at 10x). It looks best as a model
    // you look down on, so it sits between the two users at 0.3x (2.8 m wide, 0.9 m tall) and your hands reach in.
    scale: 0.3,
    center: [0, 0],
    // The starter blocks (and later the grabbable props) move beside the model so they don't sit inside a building.
    workspace: [2.0, 0],
    // Night: dark sky, violet haze, cool moonlight and a pink fill, so the model's neon (emissive) materials carry it.
    environment: {
      background: 0x0a0818, fog: [0x140b2a, 12, 80], hemisphere: [0x9b8cff, 0x2b1a55, 2.0],
      sun: [0xb8c4ff, 1.6], fill: [0xff5ad8, 1.2], floor: 0x0d0b1a, grid: false,
    },
    credit: '"Cyberpunk City - #1" by born2012 (https://sketchfab.com/born2012), CC BY 4.0',
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
};

// Loads the set's model with the given GLTFLoader, adds it to `scene` as non-interactive scenery and resolves with
// its root, or null for a set without a model. The loader is passed in so this file needs nothing but three.
export async function loadSetModel(set, scene, loader) {
  if (!set.model) return null;
  const gltf = await loader.loadAsync(set.model);
  const root = gltf.scene;
  root.name = 'scenery';
  fitScenery(root, { scale: set.scale, center: set.center, floor: set.floor });
  prepareScenery(root, set.shadows);
  scene.add(root);
  return root;
}
