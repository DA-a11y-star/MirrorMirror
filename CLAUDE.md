# Eye Tracking Hard and Soft (Hack Texas)

## Context
- Hackathon project, team of 4.
- Goal: a shared 3D workspace driven by eyes, hands, and voice. Two laptops on one LAN. Users walk around a themed **set**, build with objects they speak into existence or pull from a **library**, and see each other as lively cartoon avatars.
- **Priority is feel and responsiveness for judges, not scalability or robustness.** Prefer simple, demo-able solutions. Every step should leave something runnable.
- **This is the master document.** "Implemented" says what exists and how well it is verified. "Planned work" says what to build next, with why, where and done-when. Keep both current: when something lands, move it from Planned to Implemented and note how it was verified. There is no schedule here; order work by dependency and ease.
- `README.md` holds setup and usage detail. If the two disagree, check the code and fix both.

## Architecture
Four pieces. Python does sensing and the model calls, the browser does rendering, and a dumb relay connects the two users.

- **tracker/** (Python): webcam hand tracking, eye tracking, head pose, **static per-frame pose labels** (`open|fist|pinch|other` plus a filtered palm; `classify_pose` in `tracker/gestures.py`), landmark filtering. Temporal gesture machines (mode toggle, joysticks) do **not** live here. Serves a WebSocket on `localhost:8766` that only the local browser reads. Capture runs in its own thread and never blocks.
- **voice/** (Python, `python -m voice.main`): a separate local service on `localhost:8767`. Takes a WAV from the browser, transcribes it with Muse Voice Transcribe, asks Muse Wonder for a primitive assembly, validates and lays it out, and returns it. Needs internet and `MODEL_API_KEY`. Kept separate so a slow model call can never stall tracking.
- **web/** (three.js, plain ES modules, no bundler): renders the scene, avatars and hands; gaze targeting, manipulation, locomotion, cameras, depth effect, voice UI, object sync. Reads the local tracker feed directly (your own avatar never round-trips through the relay) and sends its state to the relay.
- **relay/** (Python `websockets`): forwards every message to all other clients. No parsing, no state, no game logic.

Key web-side ideas:
- **Blocks and assemblies.** A scene object is a root `Group`/`Mesh` in the `blocks` container with `userData.id`. The five starter blocks are plain meshes. Voice objects are **assemblies**: groups of primitive parts (`box`, `sphere`, `cylinder`, `cone`) described by a validated JSON spec (`web/object-protocol.js`). Everything targetable and grabbable lives in that container.
- **Intents.** Keyboard and mouse are read only in `input.js`, which produces one intents object per frame. `gestures.js` turns the tracker's poses into the same object (the two are summed and clamped in `main.js`), so locomotion and camera code are unchanged.
- **Host authority.** Laptop A owns the shared scene. Everyone else only renders what the host and the object's current holder send.

Existing sensing code: `tracker/hands.py`, `tracker/gestures.py`, `tracker/filters.py` were extracted from the old `hand_mouse.py` prototype (since deleted). Use webcam iris tracking with screen calibration for gaze now; keep its provider replaceable by a dedicated eye tracker later. Wrap existing sensing code rather than rewriting it.

## Layout
```
tracker/   main.py, capture.py, hands.py, gaze.py, gestures.py, filters.py (One Euro)
voice/     main.py, muse.py, planner.py, layout.py, schema.py
relay/     relay.py
web/       index.html, main.js, config.js, scene.js
           hands.js, tracker.js, mock.js, offaxis.js
           gaze.js, gaze-ui.js, gaze-validation.js
           interaction.js
           input.js, locomotion.js, camera.js, dev.js
           gestures.js, gesture-ui.js, gesture-settings.js
           avatar.js, remote-avatar.js
           net.js, sync.js, object-protocol.js, objects.js
           voice.js, voice-ui.js
           vendor/ (three.js 0.186, OrbitControls)
tests/     Node (*.test.mjs) and Python (test_*.py)
README.md, MOVEMENT_CAMERA.md (the movement/camera task spec), GESTURE_UX.md (the gesture task spec)
hand_landmarker.task, face_landmarker.task (MediaPipe models, committed so venue Wi-Fi isn't needed)
```
Planned new files are listed under Planned work (`web/sets/`, `web/library.js`, `web/gait.js`, ...).

## Running
```
pip install -r requirements.txt            # once per laptop (includes aiohttp, jsonschema for voice)
python relay/relay.py                      # laptop A only (--host / --port available)
python tracker/main.py                     # each laptop (--gaze none skips the face model)
cd web && python -m http.server 8000       # laptop A; laptop B can open A's server instead
python -m voice.main                       # only on a laptop that generates objects; key comes from .env
```
- **API key:** copy `.env.example` to `.env` and set `MODEL_API_KEY` there. `.env` is git-ignored (never commit it) and is re-read on every request, so edits need no restart. A terminal variable still works as a fallback; the file wins.
- Laptop A opens `http://localhost:8000`. Laptop B opens `http://<A's address>:8000/?user=B` and runs only its own tracker. Find A's address with `ipconfig getifaddr en0`.
- `web/config.js` holds `USER_ID`, `HOST_ID`, `RELAY_URL`, `TRACKER_URL`, `VOICE_URL`, screen size in meters (for the depth effect), `PARALLAX_STRENGTH`, `DEV_ORBIT`. `user`, `relay` and `tracker` can be overridden in the page URL (`?user=B&relay=ws://localhost:8765&tracker=mock`). **No IP address is hard-coded**: the relay is looked up on the machine that served the page.
- One laptop, two users: open two browser **windows** (not tabs: a background tab stops rendering and sending). Arrow keys move only the window you last clicked.
- Controls: arrows walk and turn, A/D strafe, Space/Shift up/down (flying is always on), M toggle MOVE/EDIT mode, V first/third person, C free cam, P depth effect, R respawn, H recenter head, backtick dev overlay. Click the scene for mouse look (Esc releases).

## Protocol
All messages are JSON, which is fine at this size on a LAN. Optimize only if measured latency demands it (see Known issues: scene size).

**tracker → web** (at tracker frame rate)
```json
{"type":"frame","t":0.0,
 "hands":[{"side":"right","lm":[[x,y,z],...21],"pinch":0.0,"pinching":false,"held":false,"t":0.0,
           "pose":"open|fist|pinch|other","pose_conf":0.0,"palm":{"x":0.5,"y":0.5,"scale":0.12}}],
 "gaze":{"x":0.5,"y":0.5,"conf":1.0},
 "head":{"pos":[x,y,z],"quat":[x,y,z,w]}}
{"type":"gesture","name":"pinch_start|pinch_end|...","hand":"right"}
```
`palm` is the filtered palm centre (landmarks 0, 5, 9, 13, 17; x is already mirrored so moving right is +x) and `scale` is wrist-to-middle-MCP size, the depth proxy. Hands include per-hand `t` and `held` (a repeated pose replayed during a brief detection gap). `infer_ms` rides on the frame for the HUD.

**web → relay → other web**
```json
{"type":"state","user":"A","seq":123,
 "avatar":{"pos":[x,y,z],"vel":[x,y,z],"yaw":0,"pitch":0,"flying":false},"head":{"quat":[x,y,z,w]}|null,"target":"b3"|null,
 "hands":[{"side","pinch","lm":[[x,y,z],...21]}],
 "held":[{"id":"b7","pos":[...],"quat":[...]}]}                    // ~30 Hz
{"type":"op","user":"A","seq":124,"opId":"A:...","op":"add|delete","obj":{...}} // render-only assembly edit
{"type":"scene","user":"A","seq":125,"acks":["A:..."],"deleted":[],"objects":[{"id","kind","pos","quat","scale","color"}]} // host, ~10 Hz; assemblies include spec
```

`avatar` is exactly `Locomotion.state()` (feet position, velocity, yaw, head pitch, fly state); the receiver drives its own `Avatar` body with it, so walk, lean and bob look the same on both laptops. Free cam never moves the avatar, so it isn't sent. The two users spawn at opposite ends, facing each other (`SPAWNS` in `scene.js`). `head.quat` is the tracker's head rotation, converted in `headQuaternion` in `remote-avatar.js`. `target` is the object the sender is looking at (violet glow on the other laptop). `hands` are the sender's tracker landmarks, drawn through the sender's eye frame. Assembly `op:add` carries `obj: {id, kind: "assembly", spec, pos, quat, scale}`; `spec` holds only version, id/name and primitive render parts. `op:delete` carries `obj: {id}`. Audio, transcripts, prompts and model/API requests stay on the generating device.

Rules:
- Each `state` message is a full snapshot. Drop anything with an older `seq`; `seq` starts at `Date.now()` so a reloaded page isn't mistaken for old traffic.
- **Ownership:** whoever grabs an object owns it and streams its transform in `held`. Everyone else only renders it. A block someone else holds can't be targeted or grabbed. If both grab the same object in the same instant, the lower user id keeps it and the other laptop lets go.
- Laptop A is the scene authority: it applies `op` messages (guests retry adds and deletes until a host scene acknowledges the exact `opId`), keeps deletion tombstones so a delayed add can't resurrect an object, and broadcasts `scene`.
- Smooth remote poses on receipt (`pos += (target - pos) * 0.3` per frame, implemented as the same easing in terms of `dt`).
- The relay keeps no state. A laptop that joins or reloads catches up from the host's 10 Hz `scene` messages, which include assembly definitions.
- After releasing an object, ignore `scene` messages for it for 400 ms (`SETTLE_MS`), so a snapshot sent before the release arrived can't pull it back. A laptop that stops sending for 700 ms loses its holds and its avatar.
- `MAX_OBJECTS` is 64 scene objects in total.

## Rendering
- three.js is vendored in `web/vendor/`. Never load it from a CDN, since venue Wi-Fi is unreliable.
- **World conventions:** meters, y-up, three.js default handedness, yaw 0 faces -z and a positive yaw turns left. All tracker-to-world mapping lives in one function in `hands.js`.
- **Style:** simple primitives, soft shadows, emissive highlight on the gaze target (amber), grab (teal) and the other user's look/hold (violet). Aim for polished and intentional, not busy.
- **Target:** a steady 60 fps.

## How to work
- Plain files that run immediately. No build tools, frameworks, or TypeScript.
- Choose the simplest thing that feels good. Hardcoding is fine, except IP addresses and API keys.
- Tests: Node (`node --test tests/*.test.mjs`) and Python (`python -m unittest discover -s tests`). New logic gets tests, and tests get **mutation-checked**: break the rule on purpose and confirm a test fails. Pure functions where possible (so they test without a browser).
- A two-browser headless-Chrome run through the real relay (mock trackers, pointer as gaze) was the end-to-end check for multiplayer. It currently lives outside the repo; moving it into `tests/` is planned.
- Git: PRs use "Create a merge commit" (not squash). Never commit `.pyc`, `.venv/` or API keys (`.gitignore` covers them). Do not commit or push unless asked.

## Milestone status
Verification legend: **unit** = Node/Python tests, **sim** = scripted simulation, **e2e** = headless two-browser run through the real relay, **live** = real camera/eyes/head/two laptops. Nothing below has been verified **live** unless stated.

| # | Milestone | State |
|---|---|---|
| 1 | Scene: floor, lighting, camera, five starter blocks | Implemented |
| 2 | Tracker streams hands to the browser | Accepted by the user (movement and responsiveness okay) |
| 3 | Locomotion | Keyboard walking/flying, first/third person, free cam, dev overlay implemented (unit). Gesture locomotion implemented (unit): mode toggle plus palm joysticks, see below. Not tuned on a real hand |
| 4 | Gaze targeting and pinch grab | Implemented, awaiting live review; accuracy unmeasured (see Known issues) |
| 5 | Relay and second user | Implemented (unit + e2e). Not tried on two real laptops or with a real head turn |
| 6 | Depth effect | Implemented by a teammate (unit); composes with the movement camera; untuned on a real person |
| 7 | Voice-to-object | Implemented and shared through the relay (unit, live API smoke check by its author); real-user rehearsal pending |
| 8 | Polish | 8a partly done (see below), 8b and 8c not started |

### Implemented, in detail
**Sensing (M2, M4).** Hand tracking with One Euro filtering, a 0.35 s dropout hold, pinch hysteresis (`CLOSE` 0.40, `OPEN` 0.46) and camera-space depth. Webcam gaze: MediaPipe face landmarker iris features, 9-point ridge-regression calibration with a leave-one-out check, smoothing, and a replaceable provider (`PROVIDERS` in `tracker/gaze.py`, or the `external` source in the browser for a hardware tracker). Head position and rotation come from the same face model. Capture is 640×480 shared by hands and gaze.

**Interaction (M4).** Forgiving gaze targeting (`web/interaction.js`): snap radius 0.14 screen heights, sticky 0.2, switch margin and delays, 300 ms grace through blinks and glances. Pinch grabs the targeted object with no snap, scales hand motion by depth (1–6×), clamps to the floor, allows one holder per object and one object per hand, freezes during a brief tracking hold and releases on sustained loss. Calibration refines itself from held grabs (offset only, with safeguards). Works on compound assemblies via `register/unregister/rootOf`.

**Fast-motion work (8a, from the `optimization` branch).** `hands.js` extrapolates fast hands along their measured velocity and raises the catch-up rate with lag; in a simulation with 100 ms of camera-to-screen delay this cut lag by about 25–40% in fast moves (149 → 94 mm at 1 m/s) with identical resting jitter (**sim**), at the cost of a few millimetres of overshoot at an abrupt stop. `OneEuroFilter` hand `d_cutoff` raised to 6 (15–25% less lag when a move starts). The tracker server wakes when a frame is ready instead of polling every 1/60 s. MediaPipe confidence thresholds lowered from 0.6 to 0.5 (**unmeasured**). A `[hands]` console line every 2 s (camera fps, inference rate, detections, held frames) plus inference time and the reason the last grab ended in the HUD. A 0.5 s grip grace stops a one-frame "open pinch" flicker from dropping a block after a fast move (it has a known drift problem: see Known issues).

**Movement and camera (M3, teammate).** `input.js` (intents), `locomotion.js` (walk 2 m/s, fly 4 m/s, smoothed velocity, ±20 m bound, respawn), `camera.js` (first person, third person with spring lag and zoom, free cam that is local only), `dev.js` overlay, and `MOVEMENT_CAMERA.md` as the spec. `DEV_ORBIT = false` by default (walking rig); `true` restores the mouse-orbit camera. Today's `Avatar` is a capsule torso, a sphere head with a visor, and a procedural bob, lean and body-turn.

**Gesture locomotion (M3).** Spec in `GESTURE_UX.md`; temporal logic in `web/gestures.js`, HUD in `web/gesture-ui.js`, a settings dropdown (per-axis sensitivity and dead zone sliders, saved in `localStorage`) in `web/gesture-settings.js`, tunables in `GESTURE` in `web/config.js` (mutate live). Verified by unit tests only (`tests/gestures.test.mjs`); not tried with a real hand.
- **Two modes**, so gestures never conflict. **MOVE** (the start mode): open palms are joysticks, pinch does nothing. **EDIT**: gaze selects and pinch grabs, open-palm motion does nothing. The HUD shows the mode (label, accent tint, flash and beep on change).
- **Toggle:** both hands fist (each held 120 ms, onsets within 700 ms) arms it, then both hands open within 1.4 s fires; 0.8 s cooldown. Both hands must be visible, so a single fist never toggles. Arming zeroes the sticks. `M` is the keyboard fallback.
- **Right hand = 3D move stick, all three axes:** push toward or pull back from the screen (palm scale) is forward/back, left/right is strafe, **raise/lower is fly up/down**. **Left hand = look:** moving right turns right, raise/lower pitches; it has its own `*_LOOK_*` dead zone and travel. Flying is always on and y is clamped to the floor; there is no walk mode or F toggle.
- **Joystick feel:** rate control from a centre captured when the palm has been open 150 ms (so it never drifts); dead zones and `EXPO` 1.8 curves per axis; **axis isolation** damps the other axes by half when one is more than 2× the rest. A fist or a pinch on that hand is a clutch (only that stick recentres on the next open palm); a lost hand decays velocity over 150 ms. The two sticks are independent. When MediaPipe labels both hands the same side (a fist does this), `tracker/hands.py` assigns left and right by x position instead of dropping one.
- **HUD:** two joystick widgets (look on the left, move on the right). On the move widget the dot's x is strafe, y is forward, and **dot size is height** (bigger = up). Dev overlay shows poses, palm, centres, raw/curved axes and the toggle state.

**Depth effect (M6, teammate).** `web/offaxis.js`: the screen behaves like a window. The view moves with the tracked head and renders through an off-axis frustum, with a minimum eye distance, a slow neutral-depth drift, and a small gaze-lean (`GAZE_REACH_M`). Grabbing uses a head-independent hand mapping so moving your head doesn't drag a held object.

**Multiplayer (M5).** `relay/relay.py` (stateless broadcast on `0.0.0.0:8765`). `web/net.js`: validated envelope, `validState/validScene/validOp`, per-sender seq dedupe, reconnect, backpressure drop. `web/sync.js`: ownership and conflict rule, host scene at 10 Hz, easing, settle window, stale-peer expiry. `web/remote-avatar.js`: the other user's walking body (the same `Avatar` class), tracker head turn on top, their hands drawn from their eye frame, and a violet glow on what they look at. Per-user spawns face each other. The status bar shows the relay address while it can't connect.

**Voice and shared objects (M7, teammate).** Browser records up to 15 s, converts to 24 kHz mono WAV, `voice/` transcribes (`muse-voice-transcribe-1.0`) and plans (`muse-wonder-1.0`, strict JSON schema, ≤40 parts, placement relations, symmetric `corners_below` legs, one repair attempt), then `web/objects.js` builds and places the assembly in free space; undo removes the last creation. `object-protocol.js` whitelists the render recipe. The generating browser sends `op:add|delete`; the host's `scene` carries definitions, acks and tombstones, so late joiners and reconnecting laptops reconstruct everything without a key. `ASR_MODEL` and `OBJECT_MODEL` override the model IDs.

**Gaze validation (partial).** `web/gaze-validation.js` has the held-out target list and the mean/p90 error summary, with tests. It is **not wired into the UI** (see Known issues).

**Tests.** 121 Node tests (120 pass) and 38 Python tests pass on `main` (`4921f31`). Multiplayer logic was mutation-checked. The two-browser e2e passed on the integrated `main`.

## Known issues and verification debt (most important first)
1. **Nothing has run live.** Not on two real laptops, not with real eyes, not with a real head turn. The head-rotation sign in `headQuaternion` is derived from the tracker's conventions and unit-tested, not checked on a real head (if the avatar turns the wrong way, fix it in that one function).
2. **Failing test on `main`.** `tests/gaze-validation.test.mjs` "UI records calibration and held-out frames…" fails: it calls `GazeUI.start(mode)`, `ui.targets` and `ui.dataset`, which `web/gaze-ui.js` doesn't have. The helper module landed without its UI. Either wire it in (planned) or remove the test.
3. **Grip grace drift.** After a fast carry the 0.5 s grace keeps the block following the hand even though the fingers opened. In simulation the block drifted back about 0.26 m after a normal stop, and followed the hand for metres if the hand kept moving. This is the "block moves when I let go" complaint again. A release margin relative to the tightest squeeze was tried earlier and reverted because grips dropped easily; do not retry it.
4. **Scene size and bandwidth.** The host sends every assembly's full spec in each 10 Hz `scene`, `deleted` and `acks` grow without bound, and the relay uses the default 1 MiB WebSocket message limit, so a large scene would drop the connection. This blocks sets (below).
5. **Gaze accuracy is unmeasured and probably too coarse.** A 0.4 m block is about as big as the error (see "Gaze quality options").
6. **Host reload resets the scene.** The host's scene is in memory only.
7. **Panels and hands.** The wide controls panel covers the far user's head at the top of the screen. The other user's hands are drawn near their body with no line to the object they hold.
8. **Voice depends on internet and `MODEL_API_KEY`** and has no offline fallback.
9. **Process.** The e2e script is outside the repo, there is no CI, and the README status table drifts from this file.

## Planned work
Ordered by dependency and ease, with no dates. Each item says why, where and when it is done.

### A. Foundations (do these before sets)
1. **Fix the failing gaze-validation test and wire validation into the UI.** *Why:* a red test on `main`, and gaze accuracy is the biggest unknown. *Where:* `web/gaze-ui.js` (`start(mode)`, `targets`, `dataset`, held-out dots from `gaze-validation.js`), a status line for mean/p90. *Done when:* the test passes, and a real run prints an error figure.
2. **Fix the grip grace.** *Why:* known drift. *How:* during the grace freeze the block instead of following the hand, and re-anchor (`grab.start`/`grab.pinch`) when the pinch returns so it doesn't jump. *Where:* `web/interaction.js`. *Done when:* tests cover a normal stop, letting go mid-swing (no movement after the open), and a one-frame flicker (grip survives), and the mutation checks fail when the rule is broken.
3. **Make scene sync scale.** *Why:* sets add many objects. *How:* send transforms at 10 Hz and assembly specs only when they change or when a peer needs them (on `op`, on a peer's first state, or in a slow separate catalog message); prune `deleted` and `acks`; set a larger `max_size` on the relay as a safety margin. *Where:* `web/sync.js`, `web/net.js`, `relay/relay.py`. *Done when:* a 60-object scene stays well under the message limit and a joiner still reconstructs everything.
4. **Move the two-browser e2e into the repo** (`tests/e2e/`, no hard-coded paths) and add a CI workflow running the Node and Python suites.
5. **Wire a mouse-and-click fallback input** (mouse as gaze, click as pinch) so the demo survives a dead camera. The intent layer and the `pointer` gaze source already exist.

### B. Sets
**What.** A set changes the world around you: ground, sky, lighting, fog, ambient effects, spawn points, and its own pool of **grabbable props**. The host switches it and both users see the same set. **On a switch, every scene object is erased completely** (starter blocks, voice objects, props).
- **Definition.** Data in `web/sets/<id>.js` plus a registry (`web/sets.js`): `{id, name, environment, scenery, props, spawns, placement}`. Authored as primitives and assembly specs, so they need no assets, work offline and are valid under `object-protocol.js`.
- **Two kinds of content.** *Scenery* is decoration: instanced meshes, deterministic from `(setId, seed)`, built locally on each laptop, never synced, not targetable. *Props* are grabbable and use the assembly path, but only their **transforms** are synced, never their specs. This is what keeps the message small.
- **Switching.** Host-only `op:set {id, seed, epoch}`. The host's `scene` carries the current set, so a late joiner or reloaded laptop builds it locally. Applying a set erases all objects, tombstones, holders and pending ops; releases grabs (`Interaction.releaseAll`); and moves avatars to the set's spawns. An `epoch` counter on `state`, `op` and `scene` makes both sides drop messages from before the switch.
- **Initial sets.** *Workshop* (today's blocks, the default), *Enchanted forest* (twisted trees, glowing mushrooms, fireflies, mist, moonlit palette), *City* (low-poly street, buildings, lamps, cars, dusk), *Poly* (a playground of assorted pastel primitives). More later (space, beach, desert).
- **Design for the depth effect.** Layer foreground, midground and background so the parallax reads.
- **Budgets.** About 24 grabbable props per set; scenery through `InstancedMesh`; show draw calls and triangles (`renderer.info`) in the dev overlay; keep 60 fps. Props must be roughly block-sized or larger because gaze targeting is coarse.
- **Placement.** `Objects.place` must respect each set's `placement` zone and colliders so a voice object never lands inside a building.
- **Switch UI.** A picker panel, a hotkey, and a voice command ("take us to the forest").
- **Depends on** A3 (scene sync scaling) and the library below (what replaces erased objects).
- **Done when:** registry validity tests (every spec passes `validAssembly`, budgets respected), deterministic build (same seed, same transforms), a switch erases everything on both laptops, stale-epoch messages are dropped, a late joiner gets the set, and the e2e covers a switch.

### C. Object library
**What.** Every object made by voice is saved to a library, so people can add more of the same without speaking again. The library starts with basic built-ins.
- **Entries.** `{id, name, spec (a grounded, centered template), thumbnail, source: builtin|voice}`. Built-ins use the four supported primitives: cube, sphere, cylinder, cone, plank, wall, chair, table, tree, house.
- **Saving.** Each generated object is added automatically (deduplicated by a hash of its spec). Persisted per laptop in `localStorage` with a size cap, with rename, delete and JSON export/import.
- **Using.** Adding creates a **new instance id** and goes through the existing `Objects.add` → `op:add` path, so the other laptop needs no library and no API.
- **Voice shortcut.** Match the spoken name against the library before calling Muse: faster, free, and works offline. The built-ins are also the fallback when Muse is unreachable.
- **Also needed.** Delete the *targeted* object (not just undo-last), duplicate it, and clear the scene.
- **UI.** Version 1 is a DOM panel with a hotkey. Later: an in-world shelf you grab objects from.
- **Set switches** erase scene objects but **keep the library** (assumed; see Open questions).
- **Files.** `web/library.js`, `web/library-ui.js`, small changes to `web/voice-ui.js` and `web/objects.js`.
- **Done when:** a generated object appears in the library, survives a reload, can be added on demand with no API call and shows up on the other laptop; a spoken built-in name skips Muse.

### D. Avatars (Rayman Legends style)
**What.** Replace the capsule-and-visor body with a cartoon character in the style of Rayman Legends: no arms, legs or neck; the head, torso, hands and feet float. Walking is procedural.
- **Parts.** Expressive head (big eyes with pupils and blinks, simple mouth), rounded torso, **floating cartoon gloves**, **floating oversized shoes**, a hair tuft or ponytail. A color per user and a floating name tag. Flat/toon shading with a cheap outline.
- **Procedural animation**, all derived locally from `Locomotion.state()`, so feet need no network data: stride phase from speed, feet follow lift-and-step arcs, torso bob, sway and lean (the existing `bob`, `leanForward`, `leanSide`), squash and stretch at footfalls, idle breathing and weight shift, random blinks, spring motion on the hair, a settle with overshoot when stopping, feet dangling while flying and **helicopter hair** in fly mode.
- **Hands (hybrid).** Glove fingers curl from the 21 tracked landmarks; the tracked hand position is mapped into body space and clamped to a reach sphere around the shoulder. With no hands visible the gloves idle and swing opposite the feet while walking. The same gloves **replace the bone-skeleton hands** in your own view. Because the limbs float, no arm IK is needed.
- **Network.** Add small fields to `state`: `emote`, `speaking`, a gaze direction for the eyes. Optionally send palm pose plus five curl values per hand instead of 63 landmark numbers (about 5× less). Pupils follow gaze and head; the mouth opens while the voice button is held.
- **Keep the `Avatar` API** (`bob`, `leanForward`, `head`, `root`, `setVisible`, `setHeadVisible`) because `tests/movement.test.mjs` asserts it, or update those tests deliberately.
- **Files.** Rework `web/avatar.js`; new `web/gait.js` (pure functions), `web/glove.js`, `web/avatar-parts.js`; `web/remote-avatar.js` drives the gloves from received hands; `web/hands.js` renders gloves.
- **Done when:** pure gait, spring and finger-curl functions are tested; feet stay planted while walking; no NaN in any state; headless screenshots show both users; gloves visibly follow real fingers (**live**).

### E. Carried-over milestone items
- **M3.** Tune the gesture sticks on a real hand (sliders in the Settings dropdown); playtest whether left/right on the right hand should strafe (now) or turn; check the right-hand vertical axis against forward drift.
- **M4.** After A1 measure real accuracy, then use the options below. Also fix the pinch-release drift only through the grip-grace change (A2), not the release margin.
- **M5.** Two-laptop rehearsal (including on a phone hotspot or ethernet in case venue Wi-Fi isolates clients); a tether line from a hand to the object it holds; a collapsible controls panel; persist the host scene (or migrate the host) so a reload doesn't wipe it; a reconnect banner.
- **M6.** Tune the depth effect on a real person; make sure it still works with the set layers.
- **M7.** Follow-up voice edits ("make it taller", "paint it red"); progress and error UX; latency measurement.
- **8a.** Read the `[hands]` stats; decide whether the 0.5 confidence change helps (detected-frames ratio before and after).
- **8b.** Side-profile (edge-on hand) stability: landmark confidence, pose fitting, identity stability while rotating, smooth recovery when the palm returns.
- **8c.** Sound, feedback, visuals, and a full two-laptop rehearsal.

### F. Polish ideas
- **One-command launcher with preflight checks:** camera permission, face model present, `MODEL_API_KEY` set, ports free, prints laptop A's address for B.
- **Demo mode** that hides dev UI, the HUD and the controls panel; a toast when the other user joins.
- **Sound, synthesized with Web Audio** (no files, works offline): grab, release, spawn, footsteps, per-set ambience.
- **Feedback:** contact shadow under held objects, a settle animation on release, a gaze dwell ring, a pinch-strength glow, a visible tether from hand to object.
- **Presence:** emotes (a wave from tracked hand motion, number keys), gaze-direction hints for the other user, name tags.
- **Resilience:** scene autosave and restore, host migration, reconnect banner, offline library fallback (see C).
- **Capture:** a photo mode for the demo.
- **Testing:** recorded tracker sessions for replay tests, the e2e and CI from A4, a Python 3.13/3.14 note in the README (a committed `.pyc` revealed teammates on different versions).
- **Gestures:** two-hand scale/rotate; palm-up to open the library.
- **Visual extras** (bloom, fireflies, set weather) only if the 60 fps budget allows.

## Gaze quality options (kept for after A1)
The user reports webcam gaze still doesn't feel good. Real-eye accuracy has never been measured, so measure before changing the model. Webcam gaze must keep working as the fallback even if an external eye tracker is adopted.

Why it feels bad (from the code; the pixel and degree figures are estimates):
- Blocks are about as small as the gaze error. A 0.4 m block is about 12% of screen height (about 2.4° on a 14" screen at 55 cm). `SNAP_RADIUS` is 0.14 (about 2.8°). Webcam gaze error is typically 3–4°.
- The iris signal is tiny. Capture is 640×480 (`CAPTURE_SIZE` in `tracker/hands.py`), shared with hands, so the iris moves only a few pixels across the whole screen.
- The model is a linear ridge fit on 4 features (iris offset averaged over both eyes, plus a nose offset). Head position and pose are not inputs, though the tracker streams them.
- `web/offaxis.js` leans the viewpoint toward the gaze and head parallax shifts the objects, so targets move while being looked at.
- Smoothing is a fixed exponential in `web/gaze.js`; One Euro is applied only to head position.

Options, roughly in order:
1. **Measure first** (A1): held-out dots, mean and p90 error, and record raw features so model variants can be replayed offline.
2. **Remove confounders:** test with `PARALLAX_STRENGTH = 0` and `GAZE_REACH_M = 0`; if the lean hurts, freeze it while an object is targeted or held.
3. **Better signal:** give the gaze path 1280×720 frames and downscale for hands; run One Euro on the features in Python.
4. **Better model:** per-eye features, `eyeLook*` blendshape scores, head position and pose as regressors, quadratic terms, calibrating with slight head motion.
5. **Design around the error:** bigger objects or a closer camera (sets help here: props should be large), the hand as a tiebreaker between nearby objects, a candidate-cycling gesture.
6. **Alternatives:** a WebGazer A/B branch (GPL-3.0, opens its own camera, same MediaPipe face model underneath), a head-pointer fallback from the streamed head orientation, or a hardware tracker through the `external` source.

## Decisions log
- Sets are **backdrop plus grabbable props**; the host switches; on a switch **all scene objects are erased**.
- The **object library** holds built-ins plus everything generated by voice; users add from it without re-speaking. Placed objects sync through the normal `op:add` path.
- Avatars are **Rayman Legends style** with **procedural walking** and **hybrid hands**: floating **cartoon gloves** follow the real tracked hands, with an idle swing when no hands are visible. Cartoon gloves replace the skeleton hands.
- **Gesture UX:** two modes (MOVE and EDIT) with separate gesture vocabularies; toggled by double fist then double open (and `M`). Python labels static poses only; JS owns the temporal state machines.
- **Right hand is a full 3D stick** (forward/back, strafe, up/down); **left hand looks** (yaw and pitch). Flying is always on; walk mode was removed. A fist or pinch clutches that hand's stick; the centre is captured at engage and never auto-drifts.
- No schedule in this document.
- Pinch release: a margin relative to the tightest squeeze (`RELEASE_MARGIN` 0.10) was tried and **reverted** (grips dropped). `CLOSE` 0.40 and `OPEN` 0.46 stand. Untried and still open: anchor the grab to a palm point; freeze instead of release (this is what A2 does for the grace period).
- WebGazer was **declined for now** (GPL-3.0, opens its own camera, same face model underneath); revisit as an A/B branch after A1.
- The first-person camera at eye height 1.4 m looking down at the workspace puts a far-end avatar at the top edge of the screen; the movement camera may mitigate this.
- Relay addresses are never hard-coded. The relay is found from the page's host, or `?relay=`.

## Open questions (Resolved)
- Does the library survive set switches? (yes: only scene objects are erased.)
- Is the library per laptop (assumed) or shared between the users? Not shared
- Names and colors for avatars A and B; should users be able to choose? Not now, not 
- Are Muse and internet guaranteed at the venue? That decides how much to lean on the built-in library and offline fallbacks. Yes there will be internet
- Sound: synthesized with Web Audio (assumed, no licensing) or recorded files? Web Audio
- Which set is the default at demo time, and who switches sets? Answered with login implmentation:
Task: Build a landing/front page for Mirror Mirror

We’ve added a lot of new functionality, and now I want a front page that users see when they first load the app. get context on the project and its existing design, and match the current visual theme and component conventions.

Layout

The project name, “Mirror Mirror,” is displayed prominently at the top.
In the center, show a selectable grid of preset sets (pre-made collections of images the user can choose from).
Bottom-right: a “Play” button (or similar wording) that starts the experience with the selected preset. Disable it until a preset is selected.
Top of the page: a toggle to switch between light and dark mode.
Presets

Create 3 placeholder presets, each with a name, a thumbnail, and a bunch of images of random objects.
Structure the data so adding a new preset is easy. For example, each preset is a self-contained definition (id, name, thumbnail, images array) in a single registry file or folder, so I can add one by dropping in a new entry or file.
Keep in mind that in the future I want to import a file (JSON or similar) that defines a preset. Design the preset format and loader with that in mind, but don’t build the import UI yet.
Selection behavior

Clicking a preset gives it a clear selected state (border, glow, or similar). Clicking again or choosing another updates the selection.
When nothing is selected, the background is a default image set. Make one up for now; University of Texas at Austin themed (campus landmarks, the Tower, longhorns, etc.) would be ideal.
When a preset is selected, the background switches to that preset’s images, with a smooth transition.
Background style

The background should be a slow, ambient, parallax-style animation like the Minecraft title screen panorama: a continuously drifting scene that feels immersive and never jarring.
Use the same effect for both the default background and the selected preset’s background.
Design direction

The overall feel should fit what we’re building: an interactive, collaborative environment.
Take inspiration from game front pages and menus, but stay consistent with our existing design system and colors.
Both light and dark modes should look polished.
