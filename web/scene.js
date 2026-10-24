import * as THREE from 'three';

const BACKGROUND = 0xd9dde3;
const BLOCK_COLORS = [0xe76f51, 0xf4a261, 0xe9c46a, 0x2a9d8f, 0x4c6ef5];

// Starter blocks so there is something to look at and, later, to grab. Sizes and positions in meters.
const STARTER_BLOCKS = [
  { id: 'b1', size: [0.4, 0.4, 0.4], pos: [-0.6, 0.2, 0.0], color: 0 },
  { id: 'b2', size: [0.4, 0.4, 0.4], pos: [-0.6, 0.6, 0.0], color: 1 },
  { id: 'b3', size: [0.8, 0.2, 0.4], pos: [0.1, 0.1, -0.3], color: 3 },
  { id: 'b4', size: [0.3, 0.6, 0.3], pos: [0.7, 0.3, 0.2], color: 4 },
  { id: 'b5', size: [0.25, 0.25, 0.25], pos: [0.1, 0.325, -0.3], color: 2 },
];

export function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.appendChild(renderer.domElement);
  return renderer;
}

// The two users stand at opposite ends of the blocks, facing each other. SPAWNS place the walking avatar (yaw 0 faces
// -z, so B turns half way around); SEATS place the fixed orbit camera used when DEV_ORBIT is on.
export const SPAWNS = {
  A: { pos: [0, 0, 3], yaw: 0, pitch: -0.35 },
  B: { pos: [0, 0, -3], yaw: Math.PI, pitch: -0.35 },
};
const SEATS = { A: [0, 1.6, 3.0], B: [0, 1.6, -3.0] };

export function createScene(userId = 'A') {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.Fog(BACKGROUND, 8, 28);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(...(SEATS[userId] ?? SEATS.A)); // standing eye height, a few steps back from the blocks
  camera.lookAt(0, 0.4, 0);

  addLights(scene);
  addFloor(scene);
  const blocks = addBlocks(scene);

  return { scene, camera, blocks };
}

function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b3a8, 1.3));

  const sun = new THREE.DirectionalLight(0xfff4e5, 2.4);
  sun.position.set(3, 6, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera;
  s.left = -6; s.right = 6; s.top = 6; s.bottom = -6; s.near = 0.5; s.far = 20;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
  fill.position.set(-4, 3, -2);
  scene.add(fill);
}

function addFloor(scene) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0xeceef1, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(20, 40, 0xb4bac4, 0xc9ced6); // 0.5 m cells
  grid.position.y = 0.001; // just above the floor to avoid z-fighting
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);
}

function addBlocks(scene) {
  const group = new THREE.Group();
  group.name = 'blocks';
  for (const b of STARTER_BLOCKS) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(...b.size),
      new THREE.MeshStandardMaterial({ color: BLOCK_COLORS[b.color], roughness: 0.55, metalness: 0.0 }),
    );
    mesh.position.set(...b.pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.id = b.id;
    group.add(mesh);
  }
  scene.add(group);
  return group;
}
