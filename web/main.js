import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { currentPreset, DEV_ORBIT, GAZE_SOURCE, GESTURE, HOST_ID, PARALLAX_STRENGTH, RELAY_URL, SET_ID, TRACKER_SOURCE, TRACKER_URL, USER_ID, VOICE_URL } from './config.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { headQuaternion, RemoteAvatar } from './remote-avatar.js';
import { GAZE_LOOK, GazeLook } from './gaze-look.js';
import { OffAxis } from './offaxis.js';
import { Hands } from './hands.js';
import { Net } from './net.js';
import { startMockTracker } from './mock.js';
import { startMouseTracker } from './mouse-tracker.js';
import { applyEnvironment, createRenderer, createScene, SPAWNS } from './scene.js';
import { SETS, loadSetModel } from './sets.js';
import { loadWorld, worldSeed } from './world.js';
import { sceneryStats } from './scenery.js';
import { loadSetProps } from './props.js';
import { random } from './set-layout.js';
import { startTracker } from './tracker.js';
import { GazeInput } from './gaze.js';
import { GazeUI } from './gaze-ui.js';
import { Interaction } from './interaction.js';
import { round, SceneSync } from './sync.js';
import { emptyIntents, Input } from './input.js';
import { FLY_CEILING, Locomotion } from './locomotion.js';
import { Avatar, EYE_HEIGHT } from './avatar.js';
import { CameraRig } from './camera.js';
import { Dev } from './dev.js';
import { Objects } from './objects.js';
import { VoiceUI } from './voice-ui.js';
import { DustCloud } from './dust.js';
import { Library } from './library.js';
import { LibraryUI } from './library-ui.js';
import { Dragon } from './dragon.js';
import { buildSetAtmosphere } from './set-atmosphere.js';
import { Gestures } from './gestures.js';
import { GestureUI } from './gesture-ui.js';

const STATE_HZ = 30; // how often this laptop sends its state to the other

const renderer = createRenderer();
const { scene, camera, blocks, look } = createScene(USER_ID);
const hands = new Hands(scene);
// `camera` is the stable base view (orbit/avatar). `view` is what the viewer's eye actually sees: the same view
// moved with their head and rendered through an off-axis frustum.
const offAxis = new OffAxis(camera, PARALLAX_STRENGTH);
const view = offAxis.view;
const gaze = new GazeInput(TRACKER_SOURCE === 'mock' || TRACKER_SOURCE === 'mouse' ? 'pointer' : GAZE_SOURCE);
const interaction = new Interaction(blocks, camera, hands, view, { onLearn: sample => gaze.learn(sample) });
const gazeUI = new GazeUI(gaze, () => interaction.releaseAll());
const objects = new Objects(blocks, interaction);
const sync = new SceneSync(blocks, { userId: USER_ID, hostId: HOST_ID, objects });
const peers = new Map(); // user id -> RemoteAvatar
const heldIds = () => new Set([...interaction.grabs.values()].map(grab => grab.mesh.userData.id));
// The object library is per laptop (localStorage); what it adds is shared like any other object.
const library = new Library({ storage: (() => { try { return localStorage; } catch { return null; } })() });
let libraryUI = null;
const voiceUI = new VoiceUI(VOICE_URL, objects, library, { onLibraryChange: () => libraryUI?.render() });
libraryUI = new LibraryUI(library, objects, interaction, { onChange: () => voiceUI.refresh() });
// Building animation: a dust cloud where the next object will land while the voice request runs, bursting when it arrives.
const dust = new DustCloud(scene);
const DUST_BASE = new THREE.Vector3();
const DUST_NDC_X = 0.32; // screen position of the loading whirl, -1..1
const DUST_NDC_Y = -0.32;
const dustWant = new THREE.Vector3();
voiceUI.onBuild = (phase, root) => {
  if (phase === 'start') {
    if (dust.state === 'building') return;
    dust.start(dustTarget(DUST_BASE)); // steerDust then keeps it in place on screen as the camera moves
  } else if (phase === 'done' && root) {
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(0.3, Math.hypot(size.x, size.z) * 0.6);
    dust.burst(DUST_BASE.set((box.min.x + box.max.x) / 2, box.min.y + radius * 0.5, (box.min.z + box.max.z) / 2), radius);
  } else dust.stop();
};
// A loading indicator has to be seen: while building, the whirl hovers at a fixed clear spot on screen (right of centre,
// below the panels) at the blocks' distance, wherever the object will eventually land. The burst happens at the object.
function dustTarget(out) {
  const dist = THREE.MathUtils.clamp(Math.hypot(camera.position.x, camera.position.z + 0.4), 2.5, 8);
  out.set(DUST_NDC_X, DUST_NDC_Y, 0.5).unproject(camera).sub(camera.position).normalize().multiplyScalar(dist).add(camera.position);
  out.y = Math.max(out.y, 0.3);
  return out;
}
function steerDust(dt) {
  if (dust.state === 'building') dust.center.lerp(dustTarget(dustWant), 1 - Math.exp(-5 * dt));
}
// The landing page's choice. Nothing consumes it yet; sets (CLAUDE.md, planned work B) will build from it.
const presetId = currentPreset();
window.app = { renderer, scene, camera, view, hands, blocks, interaction, gaze, gazeUI, offAxis, sync, peers, objects, voiceUI, library, libraryUI, presetId, dust }; // dev console

// The set's look and model. The model is scenery: it is added to the scene, not to `blocks`, so it can't be targeted.
let world = null; // the landing-page preset's world, once loaded
// A preset whose id is also a model set in sets.js (cyberpunk) loads that model; every other preset is built from
// primitives by world.js. An explicit ?set= wins over both.
const explicitSet = new URLSearchParams(location.search).get('set');
const modelPreset = !explicitSet && SETS[presetId]?.model ? presetId : null;
const set = SETS[explicitSet ?? modelPreset ?? SET_ID];
if (!set) throw new Error(`Unknown set "${SET_ID}"; known: ${Object.keys(SETS).join(', ')}`);
applyEnvironment(scene, look, set.environment);
if (set.environment?.fog) { // nothing past the fog's end is visible, so the far plane (and so the culling) stops there
  camera.far = set.environment.fog[2] + 10;
  camera.updateProjectionMatrix();
}
if (set.workspace) {
  blocks.position.set(set.workspace[0], 0, set.workspace[1]);
  look.sun.position.add(blocks.position); // the sun's shadow box follows the blocks
  look.sun.target.position.copy(blocks.position);
  look.sun.target.updateMatrixWorld();
}
window.app.set = set;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const atmosphere = buildSetAtmosphere(scene, set);
// Sets with a `dragon` setting get one circling overhead: decoration, never in `blocks`, placed from the wall clock so both laptops agree.
const dragon = set.dragon ? new Dragon(scene, set.dragon) : null;
window.app.dragon = dragon;
window.app.look = look; // dev console: tweak lights and floor live
// The landing page's preset becomes the world (unless ?set= asks for a model set explicitly).
if (presetId && !explicitSet && !modelPreset) {
  window.app.worldReady = loadWorld(presetId, { scene, look, camera, blocks }).then(loaded => {
    world = loaded;
    window.app.world = loaded;
  }).catch(error => console.error(`[world] could not load preset ${presetId}: ${error.message}`));
}
window.app.setReady = loadSetModel(set, scene, new GLTFLoader()).then(root => {
  window.app.scenery = root;
  if (root) console.info(`[set] ${set.name}: ${JSON.stringify(sceneryStats(root))}`);
  return root; // the props below build on the loaded city
}).catch(error => console.error(`[set] could not load ${set.name}: ${error.message}`));

// Avatar, camera rig and input. Keys and mouse are read only in input.js; everything below consumes intents.
const input = new Input(renderer.domElement, { mouseFallback: TRACKER_SOURCE === 'mouse' });
// Each user spawns at their own end of the blocks, a few steps back, looking down at them.
// A set with a workspace moves the blocks and both spawns there. A model set's world ends where its model does (below).
const spawn = SPAWNS[USER_ID] ?? SPAWNS.A;
const [shiftX, shiftZ] = set.workspace ?? [0, 0];
const locomotion = new Locomotion({
  spawn: { ...spawn, pitch: set.environment?.sky ? 0 : spawn.pitch, pos: [spawn.pos[0] + shiftX, spawn.pos[1], spawn.pos[2] + shiftZ] },
  ceiling: set.ceiling ?? FLY_CEILING,
});
// The set's extras (parked and hovering cars, Eve and Wall-E by the blocks, the airship), built once the city is in.
let setProps = null;
window.app.setReady.then(city => { // the edge of the world is the edge of the set's model: a town's wall, the end of a city
  if (!city) return;
  const box = new THREE.Box3().setFromObject(city);
  locomotion.setLimits({ minX: set.bound?.minX ?? box.min.x + 0.5, maxX: set.bound?.maxX ?? box.max.x - 0.5, minZ: set.bound?.minZ ?? box.min.z + 0.5, maxZ: set.bound?.maxZ ?? box.max.z - 0.5 });
});
window.app.propsReady = window.app.setReady.then(city => {
  if (!city || !set.props) return null;
  // Lamps and lanterns are shared objects like the blocks: every laptop builds the same ones (same ids), the host's scenes keep them in step.
  const addShared = spec => {
    try { sync.adopt(objects.add(spec, { place: false, remember: false, notify: false })); } catch (error) { console.warn(`[props] ${spec.id}: ${error.message}`); }
  };
  return loadSetProps(set, { scene, loader: new GLTFLoader(), city, addShared, reducedMotion, rand: random(worldSeed(set.name)) });
}).then(loaded => {
  setProps = loaded;
  window.app.props = loaded;
  if (loaded) console.info(`[props] ${JSON.stringify(loaded.stats)}`);
}).catch(error => console.error(`[props] could not build ${set.name}'s extras: ${error.message}`));
const avatar = new Avatar(scene);
// Floors are the world's: decks and paths you stand on (0 until a preset world has loaded).
const floorAt = (x, z) => world?.floorAt(x, z) ?? 0;
locomotion.floorAt = floorAt;
avatar.floorAt = floorAt;
const rig = new CameraRig(camera);
const gestures = new Gestures(GESTURE);
const gazeLook = new GazeLook(GAZE_LOOK); // the view turns toward where you look when your eyes rest near the screen edge
const headQ = new THREE.Quaternion();
// The mouse is the pinch and there are no palms to steer with, so start where pinch grabs (M still toggles).
if (TRACKER_SOURCE === 'mouse') gestures.mode = 'EDIT';
const gestureUI = new GestureUI(gestures);
const dev = new Dev(scene, blocks);
let depthFx = true;
Object.assign(window.app, { input, locomotion, avatar, rig, gestures, gestureUI, dev, avatarState: () => locomotion.state() });
const presentationButton = document.getElementById('presentation-toggle');
function togglePresentation(force) {
  const enabled = typeof force === 'boolean' ? force : !document.body.classList.contains('presentation');
  document.body.classList.toggle('presentation', enabled);
  presentationButton.setAttribute('aria-pressed', String(enabled));
  presentationButton.textContent = enabled ? 'Show controls · J' : 'Presentation · J';
}
presentationButton.addEventListener('click', () => togglePresentation());
togglePresentation(new URLSearchParams(location.search).get('demo') === '1');

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
} else if (TRACKER_SOURCE === 'mouse') {
  tracker.status = 'mouse';
  stopTracker = startMouseTracker(onTrackerMessage, camera, renderer.domElement);
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
function makePeer(user) {
  const body = new Avatar(scene);
  body.floorAt = floorAt;
  const skeleton = new Hands(scene);
  skeleton.joints.visible = skeleton.bones.visible = false; // a peer's hands are their avatar's gloves, not bones
  return new RemoteAvatar(user, body, skeleton, EYE_HEIGHT);
}
function onNetMessage(msg) {
  const now = performance.now();
  if (msg.type === 'state') {
    if (!peers.has(msg.user)) peers.set(msg.user, makePeer(msg.user));
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
    hands: (frame?.hands ?? []).map(({ side, pinch, lm }) => ({ side, pinch, lm: lm.map(p => p.map(round)), ...(gestures.restFor(side) ? { rest: true } : {}) })),
    held: sync.snapshotHeld(held),
  };
}

window.addEventListener('pagehide', () => { stopTracker(); net.stop(); }, { once: true });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  dust.setViewport(renderer.domElement.height, camera.fov);
});
dust.setViewport(renderer.domElement.height, camera.fov);

const hud = document.getElementById('hud');
let frames = 0;
let lastHud = performance.now();
const clock = new THREE.Clock();
let frameMs = 0;
let fpsShown = 0;
let lastSent = 0;
let lastMode = gestures.mode;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(clock.getDelta(), 0.05);
  frameMs += (dt * 1000 - frameMs) * 0.1;

  // Keys are ignored while the calibration overlay is up. Free cam only moves the camera, never the avatar.
  gestures.setFrame(tracker.frame?.hands ?? [], now);
  const intents = gaze.calibrating ? emptyIntents() : input.poll();
  if (intents.toggles.mode) gestures.toggleMode();
  if (gestures.mode !== lastMode) { // switching modes (gesture or M) cancels a recording or pending build
    lastMode = gestures.mode;
    voiceUI.cancel();
  }
  gestures.suppressVoice = interaction.grabs.size > 0;
  gestures.apply(intents);
  // Eyes toward the edge turn the view, as if the head turned. Not while a block is held, and not for the pointer or mouse
  // fallback, where the cursor over the panels at the screen edge would spin the view.
  const eyeLook = gazeLook.update(gaze.source === 'pointer' ? null : gaze.get(now), dt, !gaze.calibrating && interaction.grabs.size === 0);
  intents.look.dYaw += eyeLook.dYaw;
  intents.look.dPitch += eyeLook.dPitch;
  if (intents.toggles.voice) voiceUI.wake();
  if (intents.toggles.dev) dev.toggle();
  if (intents.toggles.presentation) togglePresentation();
  if (intents.toggles.library) libraryUI.toggle();
  if (intents.toggles.duplicate) libraryUI.duplicateTarget();
  if (intents.toggles.remove) libraryUI.deleteTarget();
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
    avatar.setHands(tracker.frame?.hands?.map(h => ({ ...h, rest: gestures.restFor(h.side) }))); // the glove hands copy yours (visible in third person and to the other user)
    avatar.setHeadTurn(tracker.frame?.head?.quat ? headQuaternion(tracker.frame.head.quat, headQ) : null); // your avatar's head follows your real head
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
  interaction.update(gaze.get(now), !gaze.calibrating && gestures.mode === 'EDIT', now);
  gazeUI.update(now, interaction.target?.userData.id, [...interaction.grabs.values()].map(g => g.mesh.userData.id).join(', '));
  libraryUI.update(interaction.target);
  gestureUI.update();
  world?.update(performance.now() / 1000);
  dragon?.update(reducedMotion ? 10 : undefined);
  const visualTime = reducedMotion ? 10 : now / 1000;
  atmosphere.update(visualTime, view);
  setProps?.update(reducedMotion ? 0 : dt, visualTime, view);
  steerDust(dt);
  dust.update(dt);
  dev.update({
    fps: fpsShown, frameMs, rig, locomotion, intents, camera, view, gestures, renderInfo: renderer.info.render,
    tracker, gaze: gaze.get(now), gazeTargetId: interaction.target?.userData.id, gazeTargetObject: interaction.target, now,
  });
  renderer.render(scene, view);

  sync.flushOps(now, msg => net.send(msg));
  if (now - lastSent >= 1000 / STATE_HZ) {
    lastSent = now;
    net.send(buildState(heldIds()));
  }
  const snapshot = sync.sceneSnapshot(now);
  if (snapshot) sync.sceneSent(net.send(snapshot));

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
    hud.textContent = `user ${USER_ID}${presetId ? `  ·  set ${presetId}` : ''}  ·  ${gestures.mode}  ·  ${fps} fps  ·  tracker ${tracker.status} ${trackerHz} Hz${infer}  ·  relay ${link}  ·  ${parallax}  ·  ${tracker.lastGesture}  ·  ${interaction.lastEnd}`;
    frames = 0;
    tracker.frames = 0;
    lastHud = now;
  }
});
