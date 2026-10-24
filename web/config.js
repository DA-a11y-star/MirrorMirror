// Per-laptop settings. Edit these on each machine before the demo.

export const USER_ID = 'A'; // laptop A is the scene authority
export const RELAY_URL = 'ws://192.168.1.10:8765'; // laptop A's LAN address
export const TRACKER_URL = 'ws://localhost:8766';
// 'websocket' = local Python tracker; 'mock' = animated hands for camera-free development.
export const TRACKER_SOURCE = 'websocket';
// 'webcam' = calibrated iris features; 'external' = tracker-provided screen gaze; 'pointer' = explicit dev fallback.
export const GAZE_SOURCE = 'webcam';

// Physical size of this laptop's screen, for the depth effect (14" MacBook Pro ~ 0.302 x 0.196 m).
export const SCREEN_WIDTH_M = 0.302;
export const SCREEN_HEIGHT_M = 0.196;

// Depth effect: the scene shifts with your head like a window. 0 = off, 1 = natural, 2 = exaggerated.
// Press H to recenter after settling into a different seat position.
export const PARALLAX_STRENGTH = 1;

// true = old mouse-orbit camera with no avatar. false = the avatar and camera rig (movement and camera modes).
export const DEV_ORBIT = false;
