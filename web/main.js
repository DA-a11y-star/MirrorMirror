import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEV_ORBIT, GAZE_SOURCE, PARALLAX_STRENGTH, TRACKER_SOURCE, TRACKER_URL, USER_ID } from './config.js';
import { OffAxis } from './offaxis.js';
import { Hands } from './hands.js';
import { startMockTracker } from './mock.js';
import { createRenderer, createScene } from './scene.js';
import { startTracker } from './tracker.js';
import { GazeInput } from './gaze.js';
import { GazeUI } from './gaze-ui.js';
import { Interaction } from './interaction.js';

const renderer = createRenderer();
const { scene, camera, blocks } = createScene();
const hands = new Hands(scene);
// `camera` is the stable base view (orbit/avatar). `view` is what the viewer's eye actually sees: the same view
// moved with their head and rendered through an off-axis frustum.
const offAxis = new OffAxis(camera, PARALLAX_STRENGTH);
const view = offAxis.view;
const gaze = new GazeInput(TRACKER_SOURCE === 'mock' ? 'pointer' : GAZE_SOURCE);
const interaction = new Interaction(blocks, camera, hands, view, { onLearn: sample => gaze.learn(sample) });
const gazeUI = new GazeUI(gaze, () => interaction.releaseAll());
window.app = { renderer, scene, camera, view, hands, blocks, interaction, gaze, gazeUI, offAxis }; // dev console
window.addEventListener('keydown', e => { if (e.key === 'h' || e.key === 'H') offAxis.recenter(); });

const controls = DEV_ORBIT ? new OrbitControls(camera, renderer.domElement) : null;
if (controls) {
  controls.target.set(0, 0.4, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // don't orbit under the floor
  controls.update();
}

const tracker = { frames: 0, lastGesture: '', status: 'starting', frame: null };
window.app.tracker = tracker;
function onTrackerMessage(msg) {
  if (msg.type === 'frame') {
    tracker.frame = msg;
    hands.setFrame(msg.hands);
    interaction.setFrame(msg);
    offAxis.setHead(msg.head, performance.now());
    gaze.ingest(msg, performance.now());
    gazeUI.observe(performance.now());
    tracker.frames++;
  } else if (msg.type === 'gesture') {
    tracker.lastGesture = `${msg.hand} ${msg.name}`;
  }
}
let stopTracker;
if (TRACKER_SOURCE === 'mock') {
  tracker.status = 'mock';
  stopTracker = startMockTracker(onTrackerMessage);
} else if (TRACKER_SOURCE === 'websocket') {
  stopTracker = startTracker(TRACKER_URL, onTrackerMessage, status => {
    tracker.status = status;
    if (status !== 'live' && status !== 'waiting for camera') {
      gaze.reset();
      interaction.releaseAll();
    }
  });
} else {
  throw new Error(`Unknown TRACKER_SOURCE: ${TRACKER_SOURCE}`);
}
window.addEventListener('pagehide', () => stopTracker(), { once: true });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const hud = document.getElementById('hud');
let frames = 0;
let lastHud = performance.now();
let lastFrame = performance.now();

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (controls) {
    controls.enabled = !gaze.calibrating && interaction.grabs.size === 0;
    if (controls.enabled) controls.update();
  }
  camera.updateMatrixWorld();
  offAxis.setGaze(gaze.get(now), now);
  offAxis.update(dt, now, controls ? camera.position.distanceTo(controls.target) : undefined);
  hands.update(dt, view, camera);
  interaction.update(gaze.get(now), !gaze.calibrating, now);
  gazeUI.update(now, interaction.target?.userData.id, [...interaction.grabs.values()].map(g => g.mesh.userData.id).join(', '));
  renderer.render(scene, view);

  frames++;
  if (now - lastHud > 500) {
    const seconds = (now - lastHud) / 1000;
    const fps = Math.round(frames / seconds);
    const trackerHz = Math.round(tracker.frames / seconds);
    const parallax = !offAxis.active ? 'parallax waiting for head' : `parallax ${(offAxis.eye.length() * 100).toFixed(0)} cm`;
    hud.textContent = `user ${USER_ID}  ·  ${fps} fps  ·  tracker ${tracker.status} ${trackerHz} Hz  ·  ${parallax}  ·  ${tracker.lastGesture}`;
    frames = 0;
    tracker.frames = 0;
    lastHud = now;
  }
});
