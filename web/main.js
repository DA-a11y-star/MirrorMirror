import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEV_ORBIT, GAZE_SOURCE, HOST_ID, PARALLAX_STRENGTH, RELAY_URL, TRACKER_SOURCE, TRACKER_URL, USER_ID } from './config.js';
import { RemoteAvatar } from './avatar.js';
import { OffAxis } from './offaxis.js';
import { Hands } from './hands.js';
import { Net } from './net.js';
import { startMockTracker } from './mock.js';
import { createRenderer, createScene } from './scene.js';
import { startTracker } from './tracker.js';
import { GazeInput } from './gaze.js';
import { GazeUI } from './gaze-ui.js';
import { Interaction } from './interaction.js';
import { round, SceneSync } from './sync.js';

const STATE_HZ = 30; // how often this laptop sends its state to the other

const renderer = createRenderer();
const { scene, camera, blocks } = createScene(USER_ID);
const hands = new Hands(scene);
// `camera` is the stable base view (orbit/avatar). `view` is what the viewer's eye actually sees: the same view
// moved with their head and rendered through an off-axis frustum.
const offAxis = new OffAxis(camera, PARALLAX_STRENGTH);
const view = offAxis.view;
const gaze = new GazeInput(TRACKER_SOURCE === 'mock' ? 'pointer' : GAZE_SOURCE);
const interaction = new Interaction(blocks, camera, hands, view, { onLearn: sample => gaze.learn(sample) });
const gazeUI = new GazeUI(gaze, () => interaction.releaseAll());
const sync = new SceneSync(blocks, { userId: USER_ID, hostId: HOST_ID });
const peers = new Map(); // user id -> RemoteAvatar
const heldIds = () => new Set([...interaction.grabs.values()].map(grab => grab.mesh.userData.id));
window.app = { renderer, scene, camera, view, hands, blocks, interaction, gaze, gazeUI, offAxis, sync, peers }; // dev console
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
function onNetMessage(msg) {
  const now = performance.now();
  if (msg.type === 'state') {
    if (!peers.has(msg.user)) peers.set(msg.user, new RemoteAvatar(scene, msg.user, new Hands(scene)));
    peers.get(msg.user).setState(msg, now);
    for (const id of sync.applyState(msg, now, heldIds())) interaction.drop(id);
  } else if (msg.type === 'scene') {
    sync.applyScene(msg, now, heldIds());
  }
}
const net = new Net(RELAY_URL, USER_ID, onNetMessage, () => {});
window.app.net = net;

// Everything the other laptop needs to draw this user and the blocks this user is moving.
function buildState(held) {
  const frame = tracker.frame;
  return {
    type: 'state',
    avatar: { pos: camera.position.toArray().map(round), quat: camera.quaternion.toArray().map(round) },
    head: frame?.head ? { quat: frame.head.quat } : null,
    target: interaction.target?.userData.id ?? null,
    hands: (frame?.hands ?? []).map(({ side, pinch, lm }) => ({ side, pinch, lm: lm.map(p => p.map(round)) })),
    held: sync.snapshotHeld(held),
  };
}

window.addEventListener('pagehide', () => { stopTracker(); net.stop(); }, { once: true });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const hud = document.getElementById('hud');
let frames = 0;
let lastHud = performance.now();
let lastFrame = performance.now();
let lastSent = 0;

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
  sync.update(dt, now, heldIds());
  for (const peer of peers.values()) peer.update(dt, now);
  interaction.setRemote(new Set(sync.holders.keys()), new Set([...peers.values()].map(peer => peer.looking).filter(Boolean)));
  interaction.update(gaze.get(now), !gaze.calibrating, now);
  gazeUI.update(now, interaction.target?.userData.id, [...interaction.grabs.values()].map(g => g.mesh.userData.id).join(', '));
  renderer.render(scene, view);

  if (now - lastSent >= 1000 / STATE_HZ) {
    lastSent = now;
    net.send(buildState(heldIds()));
  }
  const snapshot = sync.sceneSnapshot(now);
  if (snapshot) net.send(snapshot);

  frames++;
  if (now - lastHud > 500) {
    const seconds = (now - lastHud) / 1000;
    const fps = Math.round(frames / seconds);
    const trackerHz = Math.round(tracker.frames / seconds);
    const parallax = !offAxis.active ? 'parallax waiting for head' : `parallax ${(offAxis.eye.length() * 100).toFixed(0)} cm`;
    const others = [...peers.values()].filter(peer => peer.live).map(peer => peer.user).join(', ');
    const link = `${net.status}${net.open ? (others ? ` with ${others}` : '') : ` ${RELAY_URL}`}`; // a wrong address shows here
    hud.textContent = `user ${USER_ID}  ·  ${fps} fps  ·  tracker ${tracker.status} ${trackerHz} Hz  ·  relay ${link}  ·  ${parallax}  ·  ${tracker.lastGesture}`;
    frames = 0;
    tracker.frames = 0;
    lastHud = now;
  }
});
