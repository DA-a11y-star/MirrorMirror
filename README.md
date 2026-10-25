# Eye Tracking Hard and Soft

A shared 3D block-modeling workspace driven by eyes, hands, and voice, built for Hack Texas. Python does the sensing (webcam hand and eye tracking), the browser renders the scene with three.js, and a small relay connects two laptops on the same LAN.

`CLAUDE.md` holds the full plan: architecture, protocol, and milestones. This README covers what exists today and how to run it.

## Status

| Milestone | State |
|---|---|
| 1. Scene with floor, lighting, camera | Done (`web/`) |
| 2. Tracker streams hands to the browser | Accepted by user: movement and responsiveness are okay; live WebSocket, pinch events and recovery work |
| 3. Locomotion | Keyboard-driven walking/flying, first/third person, free camera and dev overlay implemented; gesture input remains pending |
| 4. Gaze highlight, pinch to grab | Implemented, awaiting user review: calibrated webcam gaze (replaceable provider) and local grab-and-move, a **Validate gaze** run that reports held-out error, and a mouse-and-click fallback (`?tracker=mouse`). Tests and a headless-browser run pass; accuracy on real eyes has not been measured yet |
| 5. Relay and second user | Implemented, awaiting user review: relay, face-to-face avatars with the other user's head and hands, block ownership and scene sync. Unit tests and a two-browser headless run through the real relay pass; not yet tried on two laptops or with a real head |
| 6. Depth effect | Implemented; composes with the movement camera and follows tracked head position |
| 7. Voice-to-CAD | Muse transcription → Muse Wonder primitive assemblies, shared through the relay with creation, movement, undo and late-join reconstruction; real-user rehearsal pending |
| Sets (first slice) | Cyberpunk city loads as non-interactive scenery with `?set=cyberpunk`. Unit and headless-browser checks pass; not judged on a real display. No in-app switching or sync yet |
| 8. Polish | Queued: **8a fast-motion tracking recovery**, **8b side-profile stability**, then **8c sound/feedback/visuals** |

Agreed execution order: milestone 2 → 4 → 5, with a user review after each completion. Locomotion remains milestone 3; the two newly reported tracking issues are deferred to milestone 8 unless they block the interaction demo.

## Files

```
hand_landmarker.task   MediaPipe hand model (downloaded automatically if missing)
face_landmarker.task   Committed MediaPipe face/iris model for webcam gaze
requirements.txt       Python dependencies
CLAUDE.md              Project plan, protocol, conventions
relay/
  relay.py             Dumb broadcast between the laptops: forwards each message to every other client, no state
tracker/
  main.py              Local WebSocket service + MediaPipe inference worker
  capture.py           Dedicated camera thread; latest-frame slot (no capture backlog)
  hands.py             Shared camera geometry, dropout hold, browser frame adapter
  gestures.py          Shared pinch/fist classification and pinch transition events
  filters.py           Shared One Euro filter
  gaze.py              Replaceable gaze providers (webcam iris features) and the gaze worker thread
web/
  index.html           Page shell; maps "three" to the vendored copy; gaze controls
  landing.js           Landing page: preset grid, light/dark toggle, Play (loads main.js with ?preset=<id>)
  landing.css          Landing page styles and light/dark tokens
  panorama.js          Title-screen background: a slow 360° turn inside the selected set's 3D scene
  set-scene.js         Builds a preset's scene (sky, lights, landmarks, random props) from primitives
  set-layout.js        Random prop placement (pure functions, tested)
  presets.js           Preset file format, validation and registry loader (shared with future imports)
  presets/             index.json registry plus one folder per preset (preset.json)
  config.js            Per-laptop settings (user ID, URLs, screen size, tracker and gaze source)
  main.js              Render loop, tracker and relay message handling, HUD
  tracker.js           Local WebSocket client, validation, reconnect and stale-feed timeout
  scene.js             Renderer, lights, floor, starter blocks
  hands.js             Hand skeleton rendering and the single tracker -> world mapping
  gaze.js              9-point calibration (ridge regression) and the source-independent gaze input
  gaze-ui.js           Calibration and validation overlay, gaze reticle, status line, error figure
  gaze-validation.js   Held-out targets, per-frame recording and the mean/p90 error summary
  interaction.js       Gaze targeting, highlight, pinch grab/move/release
  input.js, locomotion.js, camera.js, dev.js
                       Keyboard/mouse intents, walking and flying, first/third person and free cam, dev overlay
  avatar.js            Walking avatar body (yours, and the other user's)
  net.js               Relay client: message envelope, validation, reconnect, sequence numbers
  sync.js              Block ownership and scene sync between the two laptops
  remote-avatar.js     The other user: their walking body, head turn, hands, and what they are looking at
  mock.js              Camera-free tracker for development using the same protocol
  mouse-tracker.js     Mouse-as-hand fallback (`?tracker=mouse`): cursor is gaze and hand, left button pinches
  props.js             A set's extras: painted roads, cars on the roads and hovering above, movable street lamps, Eve and Wall-E by the blocks, an airship circling the area (planning is pure)
  roads.js             Roads from the model's ground: pavement strip, asphalt, kerbs, white lines, the road middle lines (pure; texture built from a data array)
  sets.js, scenery.js  Set registry (model, scale, night environment) and the helpers that place a model as non-interactive scenery
  assets/              Set models (`.glb`) and `CREDITS.md`. Add third-party models here and credit them
  objects.js           Primitive assembly rendering, free-space placement, undo and disposal
  object-protocol.js   Validated render-only assembly format for relay operations and scene snapshots
  voice.js             Browser recording, local WAV conversion and voice WebSocket client
  voice-ui.js          Push-to-talk, editable descriptions and generation progress
  vendor/              three.js 0.186.1 and OrbitControls, vendored (never load from a CDN)
voice/
  main.py              Independent local voice WebSocket service (localhost:8767)
  muse.py              Meta API adapters: Voice Transcribe and Muse Wonder
  planner.py           Structured assembly prompt and one layout repair attempt
  schema.py            Model-output schema and validation
  layout.py            Face alignment, repeated corner supports, scaling and grounding
tests/                 Python and Node tests (see "Milestone 2 checks" and "Milestone 4 checks")
  e2e/run.py           Two headless Chromes through the real relay (`python tests/e2e/run.py`, needs Chrome)
```


## Setup

Python 3.13 and a webcam. From this folder:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Use `.venv/bin/python -m pip`, not `.venv/bin/pip`. The existing venv was created before the folder moved, so its `pip` script points at the old path and fails.

Current MediaPipe releases (1.1.1 is installed here) no longer include the legacy `mp.solutions` API. This code uses the Tasks API (`HandLandmarker`, `FaceLandmarker`), which needs the committed model files `hand_landmarker.task` and `face_landmarker.task`. If a model is missing, the tracker downloads it; do that before arriving at the venue. If the face-model download fails, the hands keep working and the browser's gaze status line shows the error.

On macOS, grant the app you run from (Cursor, Terminal, iTerm) permissions in System Settings > Privacy & Security, then fully quit and reopen it:
- **Camera**, or the webcam won't open.

## Running the web app

From the project root, use two terminals:

```bash
# Terminal 1: webcam sensing, served only on localhost:8766
.venv/bin/python tracker/main.py

# Terminal 2: browser files
.venv/bin/python -m http.server 8000 --directory web
```

### Sets

A set is the world around the blocks: an optional 3D model plus the sky, fog, lights and floor. Pick one with `?set=<id>` (`workshop` is the default plain room). Both laptops must use the same `set`, and both need the model files, which are in the repo. There is no in-app switching or host sync yet.

| Set | Try it | What it is |
|---|---|---|
| `workshop` | `http://localhost:8000/` | The plain starting room: floor, grid and blocks |
| `cyberpunk` | `http://localhost:8000/?set=cyberpunk` (add `&user=B` on the other laptop) | A neon night city model between the two users, with the blocks moved beside it |

- **Scenery, not objects.** The model is added to the scene outside `blocks`, so it can't be targeted, grabbed or synced; hovering or dragging on it does nothing. Its transforms are frozen after loading.
- **Human scale.** The source model is a 9 m miniature (3 m towers, 1 m streets), so it is scaled 15x: towers about 46 m (a modern high-rise next to a 1.7 m person), streets about 15 m, 138 m across. The model is lowered 0.9 m (`ground` in `web/sets.js`) so its streets are at y = 0, where you and the blocks stand (before, you were inside the ground). The blocks and both spawns sit in the open street nearest the middle, 14 m east of the centre (`workspace`), with nothing overhead; walking and flying are allowed across the whole city (`bound` 90 m, `ceiling` 60 m, so you can fly over the towers). Avatars can still pass through buildings (no collisions).
- **Optimizations.** The model is split into 64 m cells so the camera skips whatever is out of view; the far plane is the fog's end (120 m), so nothing beyond the haze is drawn; scenery casts and receives no shadows; the sun's shadow box follows the blocks. In a one-off headless run (software GL, so no fps) the view from the spawn drew 17 to 113 calls depending on the user's facing, and about 69 calls and 37k triangles from 45 m up. **Not measured on a real display.** If frames drop, lower `fog` far in the set, raise or lower `chunk`, or lower the pixel ratio in `createRenderer`.
- **Roads and pavement (`web/roads.js`).** The model's ground is bare, so a texture is painted over it from the model itself. Its road-level ground becomes asphalt with a **pavement strip along every building** (up to 1.2 m, and at most 30% of the open width, so a narrow road stays a road), a light kerb and a thin **white edge line**, plus a **dashed white centre line** on roads wide enough for two lanes; its plaza-level ground (13 cm higher) becomes tiled pavement. Buildings and ground-less areas stay transparent. **The roads are connected:** an overpass or walkway no longer cuts the road under it (the road map used to treat everything below any structure as solid), and pieces of road that still stop at a gap are joined by new roads (found by a shortest-path search around the buildings, up to 70 m, with pavement edges), so the whole network is one piece; a few tiny fragments walled off from the rest stay separate. Change the strip with `props.roads.sidewalk`, the joining with `props.roads.join` in `web/sets.js`.
- **Floating junction lights.** A hovering light 7.5 m above each place where roads meet (about 12), each a dark disc with a glowing underside and a faint cone of light down to the road, in rotating pink, cyan and amber. They bob slightly; three instanced meshes in all.
- **Cars (`web/props.js`).** About 60, in every part of the city (the same on both laptops): 20 drive the roads in lanes (a lane each way where the road is wide, one down the middle where it is narrow, always wholly on asphalt, 9 to 17 m behind the next, parked in place), and 40 hover at 4, 9, 13, 19 or 27 m over the built-up area (they bob slightly), each in its own neon colour. None is inside a building. They are instanced per 50 m square of the city, so squares out of view or past the draw distance cost nothing. Tune with `props.cars` in `web/sets.js`.
- **Street lamps.** About 14, 9.8 m tall, on the pavement beside the road, 17 to 24 m apart, within 70 m of the blocks. They are **ordinary shared objects like the blocks**: look at one and pinch to pick it up and carry it, and the other laptop sees it move. (They were first built in world coordinates inside the blocks group, which is offset to the workspace, so they stood 14 m from where planned, away from the roads and from where you look: that is why they could not be grabbed.) They count toward the 64-object limit and are not undoable. Both laptops must open the same preset.
- **Eve** (1.5 m, about the avatar's size, hovering and bobbing, glowing eyes) and **Wall-E** (1.1 m, built from primitives; there is no model) stand west of the blocks facing them.
- **Airship** (32 m, 130k triangles merged into 9 meshes) flies a level circle of 95 m radius around the spawn at 50 m up (above the tallest building, just inside the draw distance), one slow lap every five minutes (about 2 m/s). Look up to see it; the circle mostly passes outside the city. If it flies backwards, set `yawOffset: Math.PI` on `airship` in `web/sets.js`.
- Tune everything under `props` in `web/sets.js`. The console prints `[props] {...}` with what was built; `app.props` has `layout` (the cars and lamps) and `world` (the road map).
- **Console:** `app.set`, `app.scenery` (its meshes are the cells) and `app.look` (lights and floor, to tweak live). The console prints `[set] Cyberpunk city: {triangles, meshes, materials}` once it loads.
- **Add a set:** put the `.glb` in `web/assets/<set>/`, add an entry to `SETS` in `web/sets.js` (`model`, `scale`, `center`, `workspace`, `chunk`, `bound`, `ceiling`, `shadows`, `environment`, `credit`) and list it in `web/assets/CREDITS.md`. A test fails if the file is missing, invalid, or has no credit.
- **Credit:** the city is by born2012 (CC BY 4.0); see `web/assets/CREDITS.md`.

Open [localhost:8000](http://localhost:8000). `TRACKER_SOURCE = 'websocket'` is the default. The HUD changes from `connecting` / `waiting for camera` to `live`, with tracker Hz. Raise your hands to see the skeletons; thumb-index pinches produce `pinch_start` / `pinch_end` in the HUD.

### Gaze and grabbing (milestone 4)

1. Size and place the browser window the way you'll use it, sit at your normal distance, and click **Calibrate gaze**.
2. Follow the dot through its nine positions with your eyes, keeping your head comfortably still. Each point captures automatically (about 1.5 s each). **Esc** cancels. If the fit is inconsistent, the status line says why; fix lighting or posture and retry.
3. A round reticle follows your gaze. The block nearest to it gets a warm glow (the reticle turns amber). The block doesn't have to be exactly under the reticle: webcam gaze is only good to a few degrees, so targeting is forgiving (see below).
4. **Pinch** (thumb and index) while a block glows to grab it. Move your hand to move the block, then un-pinch to place it. The block turns teal while held. If the pinch flickers open for a moment mid-carry, the block holds still instead of following your open hand, and carries on from where it is when the pinch returns.
5. To measure how good the gaze is, click **Validate gaze** after calibrating and look at the five dots (none is a calibration point). The panel shows the mean and 90th-percentile error in pixels and in screen heights, and the console prints it too. Validation never changes the calibration. The recorded frames are in `app.gazeUI.dataset` in the dev console.

Interaction details:
- The block stays exactly where it is when you grab it, and then follows your hand. Hand motion is scaled up by the ratio of the block's depth to your hand's depth (1x to 6x), so you can reach distant blocks.
- A block can't go below the floor. Each block has one holder at a time, and the same hand can't grab a second block while holding one.
- Only a pinch that *starts* while the glow is on a block grabs it. Pinching first and then looking at a block, or still pinching after calibrating or switching sources, does nothing until you release and pinch again.
- During a brief tracking hold (hand detection lost for under 0.35 s) the block freezes. If tracking is fully lost, the grab releases.
- Gaze only counts while it is fresh (under 350 ms old) and has confidence 0.5 or higher. A blink or lost face never picks a new block; it only keeps the current one for a moment (see grace below).

**Forgiving targeting** (`web/interaction.js`). The tuning constants are at the top of that file; distances are in screen heights (1 = full viewport height) and times in milliseconds.

| Constant | Default | Effect |
|---|---|---|
| `SNAP_RADIUS` | 0.14 | Gaze this close to a block's on-screen outline still targets it. A direct hit on the visible block always wins over a near miss |
| `STICKY_RADIUS` | 0.2 | The current target survives gaze drifting this far from its outline, so jitter at the edge doesn't flicker it |
| `SWITCH_MARGIN` | 0.04 | Another block must be this much closer than the current target to take over |
| `ACQUIRE_DELAY`, `SWITCH_DELAY` | 80, 150 | How long a new candidate must keep winning before it is highlighted or replaces the target |
| `GRACE` | 300 | How long the target survives gaze loss or looking away. A blink, or a glance at your hand as you pinch, still grabs the block you meant |

If the highlight feels twitchy, raise the delays or `SWITCH_MARGIN`. If it feels sluggish or picks nothing, raise `SNAP_RADIUS` or lower `ACQUIRE_DELAY`. A larger `SNAP_RADIUS` is more forgiving but selects more often when you're looking at empty space near a block.

**Calibration refines itself as you grab.** If you hold a grab for half a second, you evidently were looking at that block, so the gaze estimate is nudged toward it (by half the miss per grab, so about three grabs recover most of a drift). The status line shows `gaze refined` when this happens. Safeguards keep a bad grab from teaching the wrong thing:
- It only learns from a block that was the gaze-supported target for at least 250 ms before the pinch. Grabbing during a blink or glance away, or right after the block appeared, teaches nothing.
- A grab released within half a second (a wrong block you let go of) teaches nothing.
- The "truth" is the middle half of the block's outline, so a big block isn't treated as if you stared at its centre, and an estimate already inside it is left alone.
- A miss of more than 0.25 screen heights is rejected as "you weren't looking at it", and the correction can never exceed 0.25 of the viewport.
- It is an offset on top of the 9-point calibration, not a new fit, so it fixes drift but not a poor calibration. Click **Calibrate gaze** again for that. Recalibrating, resizing or switching the gaze source discards the correction. It applies to webcam gaze only.

Gaze sources (the dropdown, or `GAZE_SOURCE` in `config.js`):
- **Webcam eyes** (default). The tracker sends raw iris features; the browser maps them to screen coordinates using your calibration. Resizing the window (including entering full screen) discards the calibration, so calibrate after the window is the size you'll demo in.
- **External eye tracker.** A hardware provider only needs to send `gaze: {x, y, conf, t}` with `x`, `y` in 0 to 1 viewport coordinates, in the same `frame` messages. No calibration happens in the page. To plug one in, register a provider in `PROVIDERS` in `tracker/gaze.py` (`process(bgr_frame, observed_at)` and `close()`), run with `--gaze <name>`, and select **External eye tracker** in the dropdown.
- **Pointer (development).** The mouse acts as gaze. This is also what `TRACKER_SOURCE = 'mock'` uses.

Run the tracker with `--gaze none` to skip the face model and run only the accepted hand tracker.

The browser reconnects automatically after tracker restarts. A brief detection gap holds the last hand pose for 0.35 seconds. If the feed itself stops, the browser clears hands and releases active pinches after 0.5 seconds without a valid new frame; a socket disconnect clears immediately.

Use `--camera 1` for a different camera or `--port 8767` for a different local port (also update `TRACKER_URL`). Stop the tracker with Ctrl+C.

**No camera, or the camera died:** open the page with `?tracker=mouse`. The cursor is your gaze and your hand: hover a block to target it, hold the left button to pinch and drag to move it. Right-click the scene to mouse-look (the left click is the pinch). This mode starts in EDIT, where pinch grabs; **M** switches to MOVE and back. Other users see your hand like any other. For camera-free development with animated hands instead, set `TRACKER_SOURCE = 'mock'` in `web/config.js`. Two animated hands sway and pinch. While `DEV_ORBIT` is on, drag to orbit, scroll to zoom, and right-drag to pan. `window.app` exposes the renderer, scene, camera, hands and latest tracker frame in the dev console.

The target is a steady 60 fps. If a large or high-DPI window drops below that, lower the pixel-ratio cap in `createRenderer()` in `scene.js` from 2 to 1.5.

### Two users (milestone 5)

The two users spawn at opposite ends of the blocks, facing each other, and can walk around with the movement keys listed under **Settings** (top right) (arrow keys walk and turn). Laptop A is the scene authority.

```bash
# Laptop A only
.venv/bin/python relay/relay.py

# Laptop A: tracker and web server as above, then open http://localhost:8000
# Laptop B: tracker only, then open laptop A's web server:
#   http://<laptop A's address>:8000/?user=B
```

No address is written into the app, because it changes with every network. A page looks for the relay on the machine that served the page: laptop A finds it at `localhost`, and laptop B finds it by opening A's web server, which also means B runs A's copy of the page. B still runs its own tracker on its own camera. Find A's address with `ipconfig getifaddr en0` (or Wi-Fi settings). If B serves its own copy of the page instead, add `&relay=ws://<A's address>:8765` to the URL. The HUD shows `relay connected with B` on A and `relay connected with A` on B once both are up. While a page can't reach the relay, the HUD shows the address it is trying, so a wrong one is easy to spot.

What each user sees of the other: their walking body (the same avatar you walk with, with its walk bob and lean), a head that turns with theirs, their hands next to them, a violet glow on the block they are looking at, and a brighter glow on the block they are holding. Their avatar disappears 0.7 s after they stop sending.

Ownership:
- Whoever grabs a block owns it and streams its position; the other laptop only draws it. A block the other user holds can't be targeted or grabbed until they let go.
- If both grab the same block in the same instant, the lower user id keeps it (A over B) and the other laptop lets go.
- Laptop A rebroadcasts every block's pose about 10 times a second, and every voice object's recipe when it is new, when a laptop joins or reloads, and every couple of seconds, so a laptop that reloads or joins late catches up within a moment and a large scene stays small on the wire. If laptop A reloads, the blocks reset to the starter layout.

To try it on one laptop, run one relay and one tracker, then open two browser **windows** (not tabs: a background tab stops rendering and sending). Arrow keys only move the window you last clicked. For example `localhost:8000/?user=A&relay=ws://localhost:8765` and `localhost:8000/?user=B&relay=ws://localhost:8765`. Add `&tracker=mock` to either for camera-free animated hands. Both windows can share the one tracker, so both users' hands move together.

If the laptops can't reach each other, some venue Wi-Fi isolates clients from each other. Test this early; a phone hotspot or an ethernet cable between the laptops avoids it.

### Settings (`web/config.js`)

| Setting | Meaning |
|---|---|
| `USER_ID` | `'A'` or `'B'`, which end of the blocks you stand at. Override with `?user=B` in the page URL |
| `HOST_ID` | The scene authority, `'A'` |
| `RELAY_URL` | Where the relay is. Defaults to port 8765 on the machine that served the page. Override with `?relay=ws://<address>:8765` in the page URL |
| `TRACKER_URL` | Local tracker WebSocket, `ws://localhost:8766` |
| `VOICE_URL` | Local voice WebSocket, `ws://localhost:8767` |
| `TRACKER_SOURCE` | `'websocket'` for the local Python tracker (default), `'mock'` for animated hands, or `'mouse'` for the mouse fallback. Override with `?tracker=mouse` in the page URL |
| `GAZE_SOURCE` | `'webcam'` (calibrated iris features, default), `'external'` (tracker-provided screen coordinates), or `'pointer'` (mouse, development). Ignored in mock mode, which always uses the pointer |
| `DEV_ORBIT` | `false` (default): the walking avatar and camera rig. `true`: the old mouse-orbit camera with no walking avatar (the other user then sees an avatar derived from where your camera looks) |

### Voice-to-object generation (milestone 7)

Install the updated dependencies, then run the voice service in a **third terminal**, alongside the tracker and static web server:

```bash
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env        # then put your Meta Model API key in .env
.venv/bin/python -m voice.main
```

The key is read only by Python and is never sent to the browser. Keep it out of `web/config.js` and Git. Put the key in a `.env` file in the project folder (copy `.env.example`): `MODEL_API_KEY=...`. `.env` is git-ignored, so it never gets committed; only `.env.example`, which holds a placeholder, is tracked. The voice service re-reads `.env` on every request, so editing it takes effect without a restart. A variable exported in the terminal still works as a fallback, but the file wins. `ASR_MODEL` and `OBJECT_MODEL` can be set in `.env` too.

Open `http://localhost:8000` (or `http://127.0.0.1:8000`). The voice service accepts these browser origins and binds only to localhost. It reconnects automatically if you start it after opening the page. Tracker inference remains independent of all model requests.

1. In **Build with your voice**, hold **Hold to speak**, say an object description, and release to submit. You can also focus the button and hold Space or Enter. Grant microphone permission; if you released during the permission prompt, hold again to record.
2. Watch **Preparing audio → Transcribing → Designing**. The recognized transcript appears in the text field.
3. A low-poly object appears in an unoccupied part of the workspace. Look at any part and pinch to move the whole assembly.
4. Use **Undo creation**, or say/type “undo,” to remove the last generated object.
5. Edit the text and press **Build** to make another object without recording again.

Good demo prompts:
- “Create a blue chair with wooden legs.”
- “Make a red table with four legs.”
- “Create a tree with a brown trunk and green leaves.”
- “Build a small rocket with a red nose cone and three fins.”

**Pipeline and geometry.** The browser records up to 15 seconds with MediaRecorder, decodes locally and resamples to mono 24 kHz, 16-bit PCM WAV using Web Audio (no ffmpeg or extra microphone process). Python uploads it to `POST https://api.meta.ai/v1/asr/transcribe` using `muse-voice-transcribe-1.0`, then calls `/v1/chat/completions` with `muse-wonder-1.0` and a constrained JSON schema. Internet access and access to both models are required. Override model IDs with `ASR_MODEL` and `OBJECT_MODEL` if needed.

Wonder chooses boxes, ellipsoids, cylinders and cones, colors, dimensions, rotations and placement relationships. Python validates finite values, dimensions, IDs and references; resolves touching bounding faces and symmetric `corners_below` supports; rejects cycles and more than 40 expanded parts; and centers/grounds the object. The default largest dimension is 0.8 m; explicit requested dimensions are supported from 0.1 to 3 m. One model repair attempt handles invalid layouts. Three.js renders each assembly as a group of meshes with shared unit geometries, independent standard materials and shadows. New objects register with gaze targeting immediately; undo unregisters them and releases materials.

**Shared generated objects.** Generation runs only on the device where the command was spoken or typed. After that device renders and places the result, it sends an `op:add` containing the render recipe: primitive kinds, sizes, colors, part-local transforms and the assembly's exact world transform. The receiving laptop builds the same meshes in the same world location; it does not re-run placement, transcription or the LLM. Audio, transcripts, prompts, model requests and API keys never go through the relay. The receiver does not need an API key or a voice service to see or grab shared objects.

Laptop A remains the scene authority. Guest additions and deletions retry until a host scene acknowledges the exact operation. Host snapshots include assembly definitions, so joining/reloading laptops reconstruct existing generated objects, and reconnecting laptops catch missed deletions. Undo removes the generating user's most recent creation on every device. A received object is not added to the receiver's undo history. Generated assemblies use the same root-transform ownership rules, remote highlights, smoothing and post-release grace as starter blocks. If the relay or host is offline, the result appears locally and its edit remains queued until connectivity returns.

To rehearse on two laptops, run the relay on A and connect both pages to it as described above. Run `python -m voice.main` with `MODEL_API_KEY` only on a laptop doing generation. For microphone capture, serve that laptop's page locally at `http://localhost:8000` and use `?user=B&relay=ws://<A's address>:8765` on B. The other laptop can simply observe the scene without starting its voice service. Refresh both pages after updating the code so they understand the new assembly packets.

**Current scope.** Shared creation, grabbing/movement and undo work alongside remote avatars, walking/flying and camera modes. Follow-up editing commands (such as “make it taller”), arbitrary triangle mesh generation, physics and persistent scenes are future work. The in-memory host scene resets if laptop A reloads. An editable transcript corrects recognition errors; typed descriptions exercise the same planner.

Checks (no API key or camera required):

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_voice.py' -v
node --test tests/assembly-sync.test.mjs tests/objects.test.mjs tests/voice.test.mjs tests/interaction.test.mjs tests/net.test.mjs tests/sync.test.mjs
```

These exercise symmetric connected layouts, rotated bounds, invalid relationships, audio format/limits, Meta request contracts against a local HTTP server, the real local WebSocket pipeline with a fake model, dynamically added compound-object targeting/highlighting/grabbing, floor constraints, collision-free spawn placement, disposal and WAV sample encoding. They do not call the live Meta API.

Assembly relay checks also cover host and guest creation, render-only packet contents, exact world placement, idempotent retries, ownership streams, deletion acknowledgements, stale-scene handling, deletion while grabbed, and late joins/reconnects.

A separate live smoke check transcribed synthesized “Create a blue chair with wooden legs” through Muse Voice Transcribe and successfully generated a validated 13-part chair with Muse Wonder. A headless Chrome smoke check also exercised real MediaRecorder/Web Audio with a synthetic microphone, WAV upload, typed and spoken creation against a local fake model, WebGL rendering, transcript display and undo without browser exceptions. Real-user microphone quality and gaze/grab feel still need a manual demo rehearsal.

### Tracker data and coordinates

The browser accepts the `frame` and `gesture` messages described in `CLAUDE.md`, with these concrete conventions:

- **`lm`** is 21 landmarks per hand, in meters relative to the webcam: **x** toward the user's right (the image is mirrored), **y** down, **z** away from the webcam toward the user. This is the camera-space output of the `solvePnP` step.
- **`pinch`** is a strength from 0 (open) to 1 (touching).
- **`pinching`** is the authoritative thumb-index state after fist suppression and hysteresis. Use it / the transition events for actions rather than thresholding the visual strength again.
- **`side`** is lowercase `left` or `right`, with at most one hand per side. Duplicate handedness detections are suppressed to avoid conflicting gesture identities.
- **`frame.t`** is capture time in monotonic seconds. **`hand.t`** is the original observation time; **`held`** marks a replayed pose. Held observations don't advance filters or create new pinch events.
- **`gaze`** is `{source, x, y, conf, t, ...}`. The webcam provider sends `source: "webcam"`, `x`/`y` null, `conf` (0.8 when both eyes are valid, 0 otherwise, a geometry check and not a probability), `features` (four numbers: mean iris offset horizontal and vertical, nose offset horizontal and vertical) and a `status` string. The browser converts the features to screen coordinates with the calibration. A hardware provider sends final `x`, `y` in 0 to 1 viewport coordinates instead. With `--gaze none`, or until the model loads, `gaze` is `null` or has `conf: 0`.
- **`head`** is `{pos, quat}`: eye-midpoint position in meters from the webcam (x right, y down, z away) and head rotation. It is `null` when no face is seen. The mock supplies pointer-based gaze and a swaying head.

**Depth effect (milestone 6).** `web/offaxis.js` treats the screen as a window: the view moves with your head and is rendered through an off-axis frustum, so near things slide against far things while the focus plane stays fixed. It follows head position, not gaze direction. The first head reading counts as centered; press **H** to recenter. `PARALLAX_STRENGTH` in `config.js` scales it (0 turns it off). Grabbing uses a head-independent hand mapping, so moving your head doesn't drag a held block. Not yet tuned on a real person.

The capture thread only acquires frames. An inference worker mirrors/converts the latest image, runs MediaPipe in VIDEO mode and applies the shared `solvePnP` geometry. All 21 camera-space landmarks are One Euro filtered once per fresh observation. The WebSocket event loop runs independently; each browser consumes the latest output rather than queued old frames. Each subscriber gets pinch transitions from its delivered snapshots, including when it joins mid-pinch.

`trackerToWorld()` in `hands.js` is the only place tracker coordinates become world coordinates (meters, y-up). It treats the screen as a window the user reaches into: hands are drawn in front of the viewing camera, and pushing a hand toward the screen moves it deeper into the scene. Its constants (`HAND_GAIN`, `HAND_DROP`, `HAND_DEPTH`, `REF_Z`, `DEPTH_GAIN`) control scale and placement.

`hands.js` eases the roughly 30 Hz tracker frames into smooth 60 fps motion (`SMOOTHING_RATE`). The easing happens in tracker space, and positions are mapped with the current camera every frame, so hands stay put relative to the view while the camera moves. Hands are slotted by side so the smoothing never blends one hand into the other.

## Tuning

Sensing constants are in `tracker/hands.py`, `tracker/gestures.py` and `tracker/filters.py`.

| Constant | Effect |
|---|---|
| `CLOSE`, `OPEN` | Pinch start and release thresholds, as a fraction of hand size (wrist to middle-finger base) |
| `CAMERA_HFOV_DEG` | Webcam field of view. Depth readings scale with it, so adjust if distances look off |
| `HOLD_TIME` | How long a lost hand keeps its last pose (default 0.35 s) |

## How the tracking works

- **Landmarks.** MediaPipe returns 21 normalized image landmarks per hand plus 21 "world" landmarks in meters centered on the hand. Pinch and fist detection use the world landmarks, so they don't change as the hand tilts.
- **Handedness.** MediaPipe labels hands as they'd look in an un-mirrored image, and the frame is mirrored before detection, so the label is swapped.
- **Depth and 3D position.** `solvePnP` fits the metric world landmarks to their pixel positions using a pinhole camera with `CAMERA_HFOV_DEG`, giving each landmark's position in camera space.
- **Rotation.** The hand's axes come from the world landmarks: wrist to middle-finger base, and the knuckle-plane normal. Held shapes rotate with the knuckle normal rather than the palm normal, so a flicker in the left/right label can't spin them.
- **Smoothing.** One Euro filters on the cursor, depth, pinch point, and hand axes. A filter given a timestamp no newer than its last one returns its previous value, so held poses can't divide by a near-zero time step.
- **Dropout hold.** When fast motion blurs a hand out of detection, its last pose is replayed for `HOLD_TIME` with its original timestamp. Pinches, grabs, held mouse buttons, and held balls survive the gap, and speeds after reacquisition are measured over the real elapsed time.
- **Performance.** Capture is 640x480. At 1080p, flipping, converting, and drawing pixels capped the loop near 14 fps; at 640x480 it runs near the camera's 30 fps limit.

## Known issues

- **Webcam gaze is coarse and untested on real eyes (milestone 4).** The pipeline is verified with synthetic eye data and a sample photo, but nobody has calibrated it against a real person yet. Iris-only webcam gaze is typically accurate to a few degrees at best (a block-sized target at laptop distance), drifts if your head moves after calibration, and degrades in dim light or with glasses glare. Keep blocks reasonably large and apart, and recalibrate if the highlight feels off. A dedicated eye tracker is the intended upgrade through the `external` source.
- **The other user's head direction is untested on a real head (milestone 5).** The conversion from the tracker's head rotation is derived from its conventions and unit-tested, but nobody has turned their head and watched the other laptop. If the avatar turns the wrong way, the fix is one line in `headQuaternion` in `web/avatar.js`.
- **The other user sits near the top edge, under the controls panel.** The camera looks down at the blocks, so the person at the far end lands at the top of the view, where the wide controls panel covers their head. Narrowing or collapsing the panel, or walking closer, fixes it.
- **The other user's hands appear beside their body, not at the blocks.** Hands are drawn in front of each user's own view, as locally, and a grab moves the block by up to 6 times the hand's motion. There is no line from their hand to the block they hold.
- **Fast hand movement can lose tracking (milestone 8a).** User-confirmed. Prioritize recovery/latency and motion-blur evaluation before visual polish; keep grab state stable across brief gaps.
- **Side-profile / edge-on hands are unstable (milestone 8b).** User-confirmed. Evaluate occlusion, pose-fitting stability and reacquisition when the palm becomes visible again.
- **Fast twists can drop a grab.** Hands are keyed by MediaPipe's left/right label, which can flip when a hand twists quickly. The hand then counts as new: it still shows a pinch but no longer holds the shape. Matching hands by position fixed this but was reverted.
- **Depth is an estimate.** It assumes an average hand size and the configured field of view. Expect a little drift on held shapes.

## Milestone 5 checks

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.test.mjs
```

These cover the relay (forwards to every other client, not the sender; text passes through untouched; a leaving client doesn't affect the rest; no state kept for late joiners), the message contract and validation, sequence-number dedupe, reconnects and dropped snapshots (`net.js`), block ownership (a held block follows its holder's stream, the lower user id wins a same-instant grab, host snapshots never override a held block or pull one back right after release, quiet peers lose their holds), the other user's avatar (their walking body and its animation, head rotation, easing and turning the short way, disappearing and reappearing in place), the spawn points, and the walking avatar's state format, and the interaction rules for blocks the other user holds. Each rule was checked by deliberately breaking it and confirming a test fails.

A two-browser run in headless Chrome through the real relay, with mock trackers and the pointer as gaze, also passed: both users see each other at opposite ends with two remote hands, B's gaze target shows on A, A follows B's block while B holds it and cannot target it, both agree on the final pose after release with no jump-back, the same in the other direction, a reloaded B catches up to the host's scene, a closed B disappears from A, and neither page threw an exception. That script is a one-off with machine-specific paths and isn't in the repo.

**Manual check still needed:** two laptops on the real network, with real hands and a real head turn.

## Milestone 4 checks

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test tests/gaze.test.mjs tests/interaction.test.mjs tests/tracker.test.mjs
```

These cover iris feature extraction (blink and occlusion rejection), the calibration fit and its failure cases, gaze source switching and staleness, the grab rules above (no snap, one owner per block, freeze during a hold, release on loss), the targeting feel (snap radius, stickiness, switch margin and delays, grace through blinks) and the self-correction (recovers a simulated drift, and refuses wrong, rushed, unsupported or implausible grabs). Each tuning constant and safeguard was checked by deliberately breaking it and confirming a test fails.

A headless-Chrome run with real MediaPipe inference on a sample photo and synthetic eye samples also passed: both models' output reaches the browser, the nine-point calibration completes, gaze over a block highlights it, a pinch grabs without snapping, hand movement moves the block, release places it, and switching the gaze source clears targeting. With the estimate simulated 0.075 screen heights too high, targeting still found the block and three held grabs moved the vertical correction from 0 to +0.033, back toward the block. That script is a one-off with machine-specific paths and isn't in the repo.

**Manual check still needed:** calibrate with your real eyes, confirm the highlight lands on the block you're looking at, and grab and move a block with a pinch.

## Sets checks

```bash
node --test tests/scenery.test.mjs
.venv/bin/python tests/e2e/run.py
```

The unit tests cover placement (scaled, stood on y = 0, footprint centred), freezing and shadow flags, triangle/mesh/material counts, disposal, `chunkScenery` (every triangle kept, placement unchanged, cells beyond the far plane culled), and that every set with a model points at a valid `.glb` with a credit, a sane scale and a clear workspace. The e2e loads `?set=cyberpunk` (64,171 triangles), checks the model is outside `blocks`, and that hovering and click-dragging on it targets and grabs nothing. **Manual check still needed:** look at it on a real display, since headless frame rates are meaningless.

## Milestone 2 checks

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test tests/tracker.test.mjs
```

These cover camera-space geometry, filtering, dropout/failed-pose expiry, pinch hysteresis, actual local WebSocket delivery and reconnects, and browser message validation/stale-feed recovery. Node is only needed for the JavaScript tests, not to run the app.

Manual completion check: show both hands, pinch/release each, briefly hide then fully remove a hand, and restart the tracker while the browser stays open. Browser rendering and reconnect/stall recovery were also exercised in headless Chrome with real MediaPipe inference on a sample hand image. The user accepted movement/responsiveness; fast motion and side-profile tracking remain the prioritized polish items above.
