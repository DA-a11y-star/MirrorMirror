// Per-laptop settings. Edit these on each machine before the demo, or override them in the page URL, e.g.
// localhost:8000/?user=B&relay=ws://localhost:8765&tracker=mock to run a second user on the same laptop.
const params = new URLSearchParams(globalThis.location?.search);

export const USER_ID = params.get('user') ?? 'A'; // 'A' or 'B'
export const HOST_ID = 'A'; // laptop A is the scene authority
// The relay runs on laptop A. By default a page looks for it on the machine that served the page, so A finds it at
// localhost, and B finds it too if B opens A's web server (http://<A's address>:8000/?user=B). Otherwise pass
// ?relay=ws://<A's address>:8765. No address is hard-coded: it changes with every network.
export const RELAY_URL = params.get('relay') ?? `ws://${globalThis.location?.hostname || 'localhost'}:8765`;
export const TRACKER_URL = 'ws://localhost:8766';
export const VOICE_URL = 'ws://localhost:8767';
// 'websocket' = local Python tracker; 'mock' = animated hands for camera-free development.
export const TRACKER_SOURCE = params.get('tracker') ?? 'websocket';
// 'glasses' = Innomaker eye + forward camera; 'external' = tracker-provided coordinates.
export const GAZE_SOURCE = params.get('gaze') ?? 'webcam';

// Physical size of this laptop's screen, for the depth effect (14" MacBook Pro ~ 0.302 x 0.196 m).
export const SCREEN_WIDTH_M = 0.302;
export const SCREEN_HEIGHT_M = 0.196;

// Depth effect: the scene shifts with your head like a window. 0 = off, 1 = natural, 2 = exaggerated.
// Press H to recenter after settling into a different seat position.
export const PARALLAX_STRENGTH = 1;

// true = old mouse-orbit camera with no avatar. false = the avatar and camera rig (movement and camera modes).
export const DEV_ORBIT = false;
