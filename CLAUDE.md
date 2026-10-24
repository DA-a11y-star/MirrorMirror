# Eye Tracking Hard and Soft (Hack Texas)

## Context
- Hackathon demo, ~24 hours left, team of 4. You (Claude) are writing most of the code.
- Goal: a shared 3D block-modeling workspace driven by eyes, hands, and voice. Two laptops on one LAN.
- **Priority is feel and responsiveness for judges, not scalability or robustness.** Prefer simple, hardcoded, demo-able solutions. Every step should leave something runnable.

## Architecture
Three pieces. Python does sensing, the browser does rendering, and a dumb relay connects the two users.


- **tracker/** (Python): webcam hand tracking (already working), eye tracking, head pose, gesture classification, and landmark filtering. It serves a WebSocket on `localhost:8766` that only the local browser reads. Capture runs in its own thread and never blocks.
- **web/** (three.js, plain ES modules, no bundler): renders the scene, avatars, and hands, and handles gaze targeting, manipulation, locomotion, and the depth effect. It reads the local tracker feed directly (your own avatar never round-trips through the relay) and sends its state to the relay.
- **relay/** (Python `websockets`, about 30 lines): broadcasts every message to all other clients. It has no game logic.

Existing code: shared hand sensing lives in `tracker/hands.py`, `tracker/gestures.py`, and `tracker/filters.py`, extracted from the working `hand_mouse.py` prototype. `tracker/main.py` serves the local browser feed. Use webcam iris tracking with screen calibration for gaze now; keep its provider replaceable by a dedicated eye tracker later. Wrap existing sensing code rather than rewriting it.

## Layout
```
tracker/   main.py, hands.py, gaze.py, gestures.py, filters.py (One Euro)
relay/     relay.py
web/       index.html, main.js, config.js, scene.js, avatar.js, hands.js,
           interaction.js, locomotion.js, input.js, camera.js, dev.js, net.js, sync.js, remote-avatar.js, offaxis.js, vendor/three.module.js
```

## Running
```
python relay/relay.py                  # laptop A only
python tracker/main.py                 # each laptop
cd web && python -m http.server 8000   # each laptop, open localhost:8000
```
`web/config.js` holds `RELAY_URL`, `USER_ID`, `TRACKER_URL`, and the screen's physical width and height in meters (for the depth effect). `user`, `relay` and `tracker` can be overridden in the page URL (`?user=B&relay=ws://localhost:8765&tracker=mock`), so one laptop can run both users in two browser windows (not tabs: a background tab stops rendering and sending).

## Protocol
All messages are JSON, which is fine at this size on a LAN. Optimize only if measured latency demands it.

**tracker → web** (at tracker frame rate)
```json
{"type":"frame","t":0.0,
 "hands":[{"side":"right","lm":[[x,y,z],...21],"pinch":0.0}],
 "gaze":{"x":0.5,"y":0.5,"conf":1.0},
 "head":{"pos":[x,y,z],"quat":[x,y,z,w]}}
{"type":"gesture","name":"pinch_start|pinch_end|...","hand":"right"}
```

**web → relay → other web**
```json
{"type":"state","user":"A","seq":123,
 "avatar":{"pos":[x,y,z],"vel":[x,y,z],"yaw":0,"pitch":0,"flying":false},"head":{"quat":[x,y,z,w]}|null,"target":"b3"|null,
 "hands":[{"side","pinch","lm":[[x,y,z],...21]}],
 "held":[{"id":"b7","pos":[...],"quat":[...]}]}                    // ~30 Hz
{"type":"op","user":"A","op":"add|delete|color","obj":{...}}       // discrete edits
{"type":"scene","user":"A","seq":124,"objects":[{"id","kind","pos","quat","scale","color"}]}  // host, ~10 Hz
```

`avatar` is the sender's walking avatar, exactly `Locomotion.state()` (feet position, velocity, yaw, head pitch, fly state); the receiver drives its own `Avatar` body with it, so walk, lean and bob look the same on both laptops. Free cam never moves the avatar, so it isn't sent. The two users spawn at opposite ends of the blocks, facing each other (`SPAWNS` in `scene.js`). `head.quat` is the tracker's head rotation, converted in `headQuaternion` in `avatar.js`. `target` is the block the sender is looking at (the other laptop shows it as a violet glow). `hands` are the landmarks from the sender's tracker frame, drawn through the sender's seat. Messages without `op` handling are ignored until voice-to-CAD needs them.

Rules:
- Each `state` message is a full snapshot. Drop anything with an older `seq`.
- **Ownership:** whoever grabs an object owns it and streams its transform. Everyone else only renders it. Releasing returns ownership to the host.
- Laptop A is the scene authority. It applies `op` messages and periodically broadcasts `scene`.
- Smooth remote poses on receipt (`pos += (target - pos) * 0.3` per frame; implemented as the same easing in terms of `dt`).
- The relay keeps no state. A laptop that joins or reloads catches up from the host's 10 Hz `scene` messages.
- A block someone else holds can't be targeted or grabbed. If both grab the same block at the same instant, the lower user id keeps it and the other laptop lets go.
- After releasing a block, ignore `scene` messages for it for 400 ms, so a snapshot sent before the release arrived can't pull it back. A laptop that stops sending for 700 ms loses its holds and its avatar.
- `seq` starts at `Date.now()` so a reloaded page isn't mistaken for old traffic.


## Rendering
- three.js is vendored in `web/vendor/`. Never load it from a CDN, since venue Wi-Fi is unreliable.
- **World conventions:** meters, y-up, three.js default handedness. All tracker-to-world mapping lives in one function in `hands.js`.
- **Style:** simple primitives, soft shadows, emissive highlight on the gaze target, and instanced spheres and cylinders for hand skeletons. Aim for polished and intentional, not busy.
- **Target:** a steady 60 fps.

## How to work
- Plain files that run immediately. No build tools, frameworks, or TypeScript.
- Choose the simplest thing that feels good. Hardcoding is fine.

## Milestones
1. Scene with a floor, lighting, and a camera — implemented
2. Tracker streams hands to the browser, which draws them — accepted by user: movement and responsiveness are okay
3. One avatar walks via the finger-puppet gesture
4. Gaze highlights a block, and pinch grabs and moves it — implemented, awaiting user review: calibrated webcam gaze (9-point, `web/gaze.js`), replaceable gaze provider (`PROVIDERS` in `tracker/gaze.py`, or `external` source in the browser), local manipulation (`web/interaction.js`), forgiving gaze targeting (snap radius, hysteresis, blink grace) and calibration that refines itself from confirmed grabs. Automated tests and a headless-browser E2E pass; real-eye accuracy is not yet validated.
5. Relay shows the second user's avatar, hands, and edits — implemented, awaiting user review: `relay/relay.py`, `web/net.js` (envelope, validation, reconnect, seq dedupe), `web/sync.js` (ownership, host scene, easing), `web/avatar.js` (bust, head, remote hands, gaze glow). Unit tests and a two-browser headless run through the real relay pass; not yet tried on two laptops or with a real head. `add|delete|color` ops wait for voice-to-CAD (milestone 7).
6. Depth effect
7. Voice-to-CAD
8. Polish (in this priority order):
   - **8a. Fast-motion hand tracking/reacquisition.** User observed tracking loss during rapid movement. Measure capture/inference latency and motion blur; tune reacquisition/hold behavior without introducing sticky grabs or noticeable lag.
   - **8b. Side-profile hand stability.** User observed weak tracking when the hand is edge-on. Evaluate landmark confidence, pose fitting and identity stability during rotation; recover smoothly when the palm returns.
   - **8c. Sound, feedback, visuals and complete two-laptop rehearsal.**

Execution order agreed with the user: complete 2 → 4 → 5 first; retain milestone 3 for locomotion, then 6/7 and 8. Stop for user review after each milestone. The two tracking issues above are deferred polish work, not blockers for milestone 4; promote them only if they prevent the core interaction demo.

## M4 gaze quality: deferred options
The user reports webcam gaze still doesn't feel good. Work on it is parked while M5 is built. Real-eye accuracy has never been measured, so measure before changing the model. Webcam gaze must keep working as the fallback even if an external eye tracker is adopted.

Why it feels bad (from the code; the pixel and degree figures are estimates, not measurements):
- Blocks are about as small as the gaze error. A 0.4 m block is about 12% of screen height (about 2.4° on a 14" screen at 55 cm). `SNAP_RADIUS` is 0.14 (about 2.8°). Webcam gaze error is typically 3–4°. `b1` and `b2` are stacked and touching.
- The iris signal is tiny. Capture is 640×480 (`CAPTURE_SIZE` in `tracker/hands.py`), shared with hands, so the iris moves only a few pixels across the whole screen.
- The model is a linear ridge fit on 4 features: iris offset averaged over both eyes, plus a nose offset as a head cue. Head position and pose are not inputs, though the tracker streams them.
- `web/offaxis.js` leans the viewpoint toward the gaze (`GAZE_REACH_M`) and head parallax shifts the blocks, so the targets move while being looked at.
- Smoothing is a fixed exponential in `web/gaze.js`. One Euro is applied only to head position.

Options, roughly in order:
1. **Measure first.** Add a validation mode with held-out dots that reports mean and p90 error. Record raw features so model variants can be replayed offline on real data.
2. **Remove confounders.** Test with `PARALLAX_STRENGTH = 0` and `GAZE_REACH_M = 0`. If the lean hurts, freeze it while a block is targeted or held.
3. **Better signal.** Give the gaze path 1280×720 frames and downscale for hands. Run One Euro on the features in Python.
4. **Better model.** Per-eye features, `eyeLook*` blendshape scores, head position and pose as regressors, quadratic terms, calibrating with slight head motion. Which helps is unknown; use option 1 to find out.
5. **Design around the error.** Bigger blocks or a closer camera, the hand as a tiebreaker between nearby blocks, a candidate-cycling gesture.
6. **Alternatives.** A WebGazer A/B branch (GPL-3.0, opens its own camera, same MediaPipe face model underneath), a head-pointer fallback source from the streamed head orientation, or a hardware tracker through the `external` source.

Other open items: the pinch-release drift (a release margin relative to the tightest squeeze was tried and reverted because grips dropped; untried: anchor the grab to a palm point, or freeze the block instead of releasing) and committing `face_landmarker.task` so the second laptop needs no internet.
