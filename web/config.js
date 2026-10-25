// Per-laptop settings. Edit these on each machine before the demo, or override them in the page URL, e.g.
// localhost:8000/?user=B&relay=ws://localhost:8765&tracker=mock to run a second user on the same laptop.
const params = new URLSearchParams(globalThis.location?.search);

export const USER_ID = params.get('user') ?? 'A'; // 'A' or 'B'
// The preset chosen on the landing page (?preset=<id>), or null. A function, not a constant: the landing page loads
// this module before Play writes the choice into the URL.
export const currentPreset = () => new URLSearchParams(globalThis.location?.search).get('preset');
export const HOST_ID = 'A'; // laptop A is the scene authority
// The relay runs on laptop A. By default a page looks for it on the machine that served the page, so A finds it at
// localhost, and B finds it too if B opens A's web server (http://<A's address>:8000/?user=B). Otherwise pass
// ?relay=ws://<A's address>:8765. No address is hard-coded: it changes with every network.
export const RELAY_URL = params.get('relay') ?? `ws://${globalThis.location?.hostname || 'localhost'}:8765`;
export const TRACKER_URL = 'ws://localhost:8766';
export const VOICE_URL = 'ws://localhost:8767';
// 'websocket' = local Python tracker; 'mock' = animated hands for camera-free development.
export const TRACKER_SOURCE = params.get('tracker') ?? 'websocket';
// 'webcam' = calibrated iris features; 'external' = tracker-provided screen gaze; 'pointer' = explicit dev fallback.
export const GAZE_SOURCE = 'webcam';

// Depth effect: the scene shifts with your head like a window. 0 = off, 1 = natural, 2 = exaggerated.
// Press H to recenter after settling into a different seat position.
export const PARALLAX_STRENGTH = 1;

// true = old mouse-orbit camera with no avatar. false = the avatar and camera rig (movement and camera modes).
export const DEV_ORBIT = false;

// Gesture locomotion. Mutate this object from the console or the dev sliders; the next frame picks it up.
export const GESTURE = {
  DOMINANT: 'right',           // open right hand = move; open left hand = look left/right
  DEAD_LATERAL: 0.28,
  DEAD_VERTICAL: 0.28,
  DEAD_DEPTH: 0.08,
  FULL_LATERAL: 1.6,           // right strafe / left look-yaw
  FULL_VERTICAL: 1.8,          // right fly up/down, left look-pitch
  DEAD_LOOK_LATERAL: 0.28,      // left-hand look has its own dead zone and travel
  DEAD_LOOK_VERTICAL: 0.28,
  FULL_LOOK_LATERAL: 0.9,
  FULL_LOOK_VERTICAL: 1.1,
  FULL_DEPTH: 0.4,             // right forward/back — larger = less sensitive
  EXPO: 1.8,
  ENGAGE_MS: 150,
  DISENGAGE_MS: 150,           // how long velocity decays to zero after a fist / lost hand
  LOW_CONF_MS: 100,            // pose_conf below 0.5 this long disengages
  TOGGLE_FIST_MS: 120,
  TOGGLE_ONSET_MS: 700,        // the two fists must start within this of each other
  TOGGLE_OPEN_WINDOW_MS: 1400,
  TOGGLE_COOLDOWN_MS: 800,
  AXIS_ISOLATION: 2,           // if one axis is this many times the others, damp the others
  AXIS_ISOLATION_SCALE: 0.5,
};
