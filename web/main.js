import * as THREE from 'three';
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
import { emptyIntents, Input } from './input.js';
import { Locomotion } from './locomotion.js';
import { Avatar } from './avatar.js';
import { CameraRig } from './camera.js';
import { Dev } from './dev.js';

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

// Avatar, camera rig and input. Keys and mouse are read only in input.js; everything below consumes intents.
const input = new Input(renderer.domElement);
// Spawn where the old fixed camera stood: a few steps back from the blocks, looking down at them.
const locomotion = new Locomotion({ spawn: { pos: [0, 0, 3], yaw: 0, pitch: -0.35 } });
const avatar = new Avatar(scene);
const rig = new CameraRig(camera);
const dev = new Dev(scene, blocks);
let depthFx = true;
Object.assign(window.app, { input, locomotion, avatar, rig, dev, avatarState: () => locomotion.state() });

const controls = DEV_ORBIT ? new OrbitControls(camera, renderer.domElement) : null;
if (controls) {
  controls.target.set(0, 0.4, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // don't orbit under the floor
  controls.update();
}

const tracker = { frames: 0, lastGesture: '', status: 'starting', frame: null, at: 0 };
window.app.tracker = tracker;
function onTrackerMessage(msg) {
  if (msg.type === 'frame') {
    tracker.frame = msg;
    tracker.at = performance.now();
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
const clock = new THREE.Clock();
let frameMs = 0;
let fpsShown = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(clock.getDelta(), 0.05);
  frameMs += (dt * 1000 - frameMs) * 0.1;

  // Keys are ignored while the calibration overlay is up. Free cam only moves the camera, never the avatar.
  const intents = gaze.calibrating ? emptyIntents() : input.poll();
  if (intents.toggles.dev) dev.toggle();
  if (intents.toggles.recenter) offAxis.recenter();
  if (intents.toggles.depthFx) {
    depthFx = !depthFx;
    offAxis.strength = depthFx ? PARALLAX_STRENGTH : 0;
  }

  if (controls) {
    controls.enabled = !gaze.calibrating && interaction.grabs.size === 0;
    if (controls.enabled) controls.update();
  } else {
    locomotion.update(intents, dt, !rig.freeActive && !intents.toggles.freeCam);
    const state = locomotion.state();
    avatar.update(state, dt);
    rig.update(intents, state, avatar.bob, dt);
    avatar.setVisible(!rig.hideAvatar);
  }
  camera.updateMatrixWorld();
  offAxis.setGaze(gaze.get(now), now);
  offAxis.update(dt, now, controls ? camera.position.distanceTo(controls.target) : rig.focus);
  hands.update(dt, view, camera);
  interaction.update(gaze.get(now), !gaze.calibrating, now);
  gazeUI.update(now, interaction.target?.userData.id, [...interaction.grabs.values()].map(g => g.mesh.userData.id).join(', '));
  dev.update({
    fps: fpsShown, frameMs, rig, locomotion, intents, camera, view,
    tracker, gaze: gaze.get(now), gazeTargetId: interaction.target?.userData.id, gazeTargetObject: interaction.target, now,
  });
  renderer.render(scene, view);

  frames++;
  if (now - lastHud > 500) {
    const seconds = (now - lastHud) / 1000;
    const fps = Math.round(frames / seconds);
    fpsShown = fps;
    const trackerHz = Math.round(tracker.frames / seconds);
    const parallax = !offAxis.active ? 'parallax waiting for head' : `parallax ${(offAxis.eye.length() * 100).toFixed(0)} cm`;
    hud.textContent = `user ${USER_ID}  ·  ${fps} fps  ·  tracker ${tracker.status} ${trackerHz} Hz  ·  ${parallax}  ·  ${tracker.lastGesture}`;
    frames = 0;
    tracker.frames = 0;
    lastHud = now;
  }
});
