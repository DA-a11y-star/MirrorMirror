import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEV_ORBIT, GAZE_SOURCE, HOST_ID, PARALLAX_STRENGTH, RELAY_URL, TRACKER_SOURCE, TRACKER_URL, USER_ID, VOICE_URL } from './config.js';
import { RemoteAvatar } from './remote-avatar.js';
import { OffAxis } from './offaxis.js';
import { Hands } from './hands.js';
import { Net } from './net.js';
import { startMockTracker } from './mock.js';
import { createRenderer, createScene, SPAWNS } from './scene.js';
import { startTracker } from './tracker.js';
import { GazeInput } from './gaze.js';
import { GazeUI } from './gaze-ui.js';
import { Interaction } from './interaction.js';
import { round, SceneSync } from './sync.js';
import { emptyIntents, Input } from './input.js';
import { Locomotion } from './locomotion.js';
import { Avatar, EYE_HEIGHT } from './avatar.js';
import { CameraRig } from './camera.js';
import { Dev } from './dev.js';
import { Objects } from './objects.js';
import { VoiceUI } from './voice-ui.js';

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
const objects = new Objects(blocks, interaction);
const sync = new SceneSync(blocks, { userId: USER_ID, hostId: HOST_ID, objects });
const peers = new Map(); // user id -> RemoteAvatar
const heldIds = () => new Set([...interaction.grabs.values()].map(grab => grab.mesh.userData.id));
const voiceUI = new VoiceUI(VOICE_URL, objects);
window.app = { renderer, scene, camera, view, hands, blocks, interaction, gaze, gazeUI, offAxis, sync, peers, objects, voiceUI }; // dev console

// Avatar, camera rig and input. Keys and mouse are read only in input.js; everything below consumes intents.
const input = new Input(renderer.domElement);
// Each user spawns at their own end of the blocks, a few steps back, looking down at them.
const locomotion = new Locomotion({ spawn: SPAWNS[USER_ID] ?? SPAWNS.A });
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
function onNetMessage(msg) {
  const now = performance.now();
  if (msg.type === 'state') {
    if (!peers.has(msg.user)) peers.set(msg.user, new RemoteAvatar(msg.user, new Avatar(scene), new Hands(scene), EYE_HEIGHT));
    peers.get(msg.user).setState(msg, now);
    for (const id of sync.applyState(msg, now, heldIds())) interaction.drop(id);
  } else if (msg.type === 'scene') {
    sync.applyScene(msg, now, heldIds());
    voiceUI.refresh();
  } else if (msg.type === 'op') {
    sync.applyOp(msg);
    voiceUI.refresh();
  }
}
const net = new Net(RELAY_URL, USER_ID, onNetMessage, () => {});
window.app.net = net;

// What the other laptop needs to draw this user's body: the walking avatar's own state. The orbit camera has no
// avatar, so there one is derived from where the camera stands and looks. Free cam never moves the avatar.
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
function avatarSnapshot() {
  if (!controls) {
    const state = locomotion.state();
    return { pos: state.pos.map(round), vel: state.vel.map(round), yaw: round(state.yaw), pitch: round(state.pitch), flying: state.flying };
  }
  euler.setFromQuaternion(camera.quaternion);
  const { x, y, z } = camera.position;
  return { pos: [x, Math.max(0, y - EYE_HEIGHT), z].map(round), vel: [0, 0, 0], yaw: round(euler.y), pitch: round(euler.x), flying: false };
}

// Everything the other laptop needs to draw this user and the blocks this user is moving.
function buildState(held) {
  const frame = tracker.frame;
  return {
    type: 'state',
    avatar: avatarSnapshot(),
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
const clock = new THREE.Clock();
let frameMs = 0;
let fpsShown = 0;
let lastSent = 0;

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
  sync.update(dt, now, heldIds());
  for (const peer of peers.values()) peer.update(dt, now);
  interaction.setRemote(new Set(sync.holders.keys()), new Set([...peers.values()].map(peer => peer.looking).filter(Boolean)));
  interaction.update(gaze.get(now), !gaze.calibrating, now);
  gazeUI.update(now, interaction.target?.userData.id, [...interaction.grabs.values()].map(g => g.mesh.userData.id).join(', '));
  dev.update({
    fps: fpsShown, frameMs, rig, locomotion, intents, camera, view,
    tracker, gaze: gaze.get(now), gazeTargetId: interaction.target?.userData.id, gazeTargetObject: interaction.target, now,
  });
  renderer.render(scene, view);

  sync.flushOps(now, msg => net.send(msg));
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
    fpsShown = fps;
    const trackerHz = Math.round(tracker.frames / seconds);
    const parallax = !offAxis.active ? 'parallax waiting for head' : `parallax ${(offAxis.eye.length() * 100).toFixed(0)} cm`;
    const others = [...peers.values()].filter(peer => peer.live).map(peer => peer.user).join(', ');
    const link = `${net.status}${net.open ? (others ? ` with ${others}` : '') : ` ${RELAY_URL}`}`; // a wrong address shows here
    const infer = tracker.frame?.infer_ms != null ? ` (${tracker.frame.infer_ms} ms)` : '';
    hud.textContent = `user ${USER_ID}  ·  ${fps} fps  ·  tracker ${tracker.status} ${trackerHz} Hz${infer}  ·  relay ${link}  ·  ${parallax}  ·  ${tracker.lastGesture}  ·  ${interaction.lastEnd}`;
    frames = 0;
    tracker.frames = 0;
    lastHud = now;
  }
});
