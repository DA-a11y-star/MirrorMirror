import * as THREE from 'three';
import { loadPreset } from './presets.js';
import { buildSetScene } from './set-scene.js';
import { random } from './set-layout.js';
import { floorRects, makeFloorAt } from './floor.js';

// The workspace's world: the preset chosen on the landing page, built with the same builder as the landing page's
// background (sky dome, fog, ground, sun, props) and added to the workspace scene as scenery. Scenery is never put in
// `blocks`: Interaction raycasts everything in there, so scenery would cost frame time and become grabbable.
const FAR = 240; // the sky dome is 120 m out, farther than the plain room's camera could see

// The same seed on both laptops, so both users see the same trees, cars and benches.
export function worldSeed(id) {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function presetUrl(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(id ?? '')) throw new Error(`Bad preset id "${id}"`);
  return new URL(`./presets/${id}/preset.json`, import.meta.url).href;
}

// Builds the preset's world into `scene`. `look` is createScene()'s handles to the plain room's lights and floor, which
// the preset's own lighting replaces. Resolves with { preset, group, update(seconds), blocksY }.
export async function loadWorld(id, { scene, look, camera, blocks }) {
  const preset = await loadPreset(presetUrl(id));
  const built = buildSetScene(preset, random(worldSeed(id)));
  const group = new THREE.Group();
  group.name = 'world';
  for (const child of [...built.scene.children]) group.add(child);
  group.traverse(node => { node.userData.scenery = true; });
  scene.add(group);

  scene.background = built.scene.background;
  scene.fog = built.scene.fog;
  look.floor.visible = false;
  look.grid.visible = false;
  for (const light of [look.hemisphere, look.sun, look.fill]) light.intensity = 0; // the preset lights the world now
  camera.far = FAR;
  camera.updateProjectionMatrix();
  const floorAt = makeFloorAt(floorRects(preset, built.layout)); // decks and paths you can stand on
  const blocksY = floorAt(blocks.position.x, blocks.position.z);
  blocks.position.y = blocksY;
  return { preset, group, blocksY, floorAt, update: seconds => built.update(seconds) };
}
