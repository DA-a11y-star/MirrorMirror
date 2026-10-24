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
           interaction.js, locomotion.js, net.js, offaxis.js, vendor/three.module.js
```

## Running
```
python relay/relay.py                  # laptop A only
python tracker/main.py                 # each laptop
cd web && python -m http.server 8000   # each laptop, open localhost:8000
```
`web/config.js` holds `RELAY_URL`, `USER_ID`, `TRACKER_URL`, and the screen's physical width and height in meters (for the depth effect).

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
 "avatar":{"pos":[x,y,z],"yaw":0},"head":{...},"gaze_ray":{...},
 "hands":[...],"held":[{"id":"b7","pos":[...],"quat":[...]}]}      // ~30 Hz
{"type":"op","user":"A","op":"add|delete|color","obj":{...}}       // discrete edits
{"type":"scene","objects":[{"id","kind","pos","quat","scale","color"}]}  // host, ~10 Hz
```

Rules:
- Each `state` message is a full snapshot. Drop anything with an older `seq`.
- **Ownership:** whoever grabs an object owns it and streams its transform. Everyone else only renders it. Releasing returns ownership to the host.
- Laptop A is the scene authority. It applies `op` messages and periodically broadcasts `scene`.
- Smooth remote poses on receipt (`pos += (target - pos) * 0.3` per frame).


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
5. Relay shows the second user's avatar, hands, and edits
6. Depth effect
7. Voice-to-CAD
8. Polish (in this priority order):
   - **8a. Fast-motion hand tracking/reacquisition.** User observed tracking loss during rapid movement. Measure capture/inference latency and motion blur; tune reacquisition/hold behavior without introducing sticky grabs or noticeable lag.
   - **8b. Side-profile hand stability.** User observed weak tracking when the hand is edge-on. Evaluate landmark confidence, pose fitting and identity stability during rotation; recover smoothly when the palm returns.
   - **8c. Sound, feedback, visuals and complete two-laptop rehearsal.**

Execution order agreed with the user: complete 2 → 4 → 5 first; retain milestone 3 for locomotion, then 6/7 and 8. Stop for user review after each milestone. The two tracking issues above are deferred polish work, not blockers for milestone 4; promote them only if they prevent the core interaction demo.
