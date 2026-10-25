import { DEFAULTS } from './gestures.js';

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
// 'websocket' = local Python tracker; 'mock' = animated hands for camera-free development; 'mouse' = the cursor is
// gaze and hand, left button pinches, right-click mouse-looks (a fallback for a dead camera).
export const TRACKER_SOURCE = params.get('tracker') ?? 'websocket';
// Which world to show: 'workshop' (the plain room, default) or 'cyberpunk' (the model city). ?set=cyberpunk
export const SET_ID = params.get('set') ?? 'workshop';
// 'webcam' = calibrated iris features; 'external' = tracker-provided screen gaze; 'pointer' = explicit dev fallback.
export const GAZE_SOURCE = 'webcam';

// Depth effect: the scene shifts with your head like a window. 0 = off, 1 = natural, 2 = exaggerated.
// Press H to recenter after settling into a different seat position.
export const PARALLAX_STRENGTH = 1;

// true = old mouse-orbit camera with no avatar. false = the avatar and camera rig (movement and camera modes).
export const DEV_ORBIT = false;

// Gesture locomotion tunables live in gestures.js (DEFAULTS). This is the live copy: mutate it from the console or the dev
// sliders and the next frame picks it up.
export const GESTURE = { ...DEFAULTS };
