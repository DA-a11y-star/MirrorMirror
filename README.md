# Eye Tracking Hard and Soft

A shared 3D block-modeling workspace driven by eyes, hands, and voice, built for Hack Texas. Python does the sensing (webcam hand and eye tracking), the browser renders the scene with three.js, and a small relay connects two laptops on the same LAN.

`CLAUDE.md` holds the full plan: architecture, protocol, and milestones. This README covers what exists today and how to run it.

## Status

| Milestone | State |
|---|---|
| 1. Scene with floor, lighting, camera | Done (`web/`) |
| 2. Tracker streams hands to the browser | Accepted by user: movement and responsiveness are okay; live WebSocket, pinch events and recovery work |
| 3. Finger-puppet walking | Not started |
| 4. Gaze highlight, pinch to grab | Implemented, awaiting user review: calibrated webcam gaze (replaceable provider) and local grab-and-move. Tests and a headless-browser run pass; accuracy on real eyes is not yet validated |
| 5. Relay and second user | Implemented, awaiting user review: relay, face-to-face avatars with the other user's head and hands, block ownership and scene sync. Unit tests and a two-browser headless run through the real relay pass; not yet tried on two laptops or with a real head |
| 6. Depth effect | Not started |
| 7. Voice-to-CAD | Not started |
| 8. Polish | Queued: **8a fast-motion tracking recovery**, **8b side-profile stability**, then **8c sound/feedback/visuals** |

The browser tracker reuses the sensing algorithms from the standalone OpenCV prototype (`hand_mouse.py`). Shared camera geometry, gesture classification and One Euro filtering now live in `tracker/`; the prototype imports these same helpers.

Agreed execution order: milestone 2 → 4 → 5, with a user review after each completion. Locomotion remains milestone 3; the two newly reported tracking issues are deferred to milestone 8 unless they block the interaction demo.

## Files

```
hand_mouse.py          Standalone hand-tracking prototype (OpenCV window): gestures, depth, rotation,
                       grabbable 3D shapes, mouse control, juggling
juggle.py              Juggling physics used by hand_mouse.py
hand_landmarker.task   MediaPipe hand model (downloaded automatically if missing)
face_landmarker.task   MediaPipe face/iris model for webcam gaze (downloaded once on first run; gitignored)
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
  config.js            Per-laptop settings (user ID, URLs, screen size, tracker and gaze source)
  main.js              Render loop, tracker and relay message handling, HUD
  tracker.js           Local WebSocket client, validation, reconnect and stale-feed timeout
  scene.js             Renderer, lights, floor, starter blocks
  hands.js             Hand skeleton rendering and the single tracker -> world mapping
  gaze.js              9-point calibration (ridge regression) and the source-independent gaze input
  gaze-ui.js           Calibration overlay, gaze reticle, status line
  interaction.js       Gaze targeting, highlight, pinch grab/move/release
  net.js               Relay client: message envelope, validation, reconnect, sequence numbers
  sync.js              Block ownership and scene sync between the two laptops
  avatar.js            The other user: bust, head, hands, and what they are looking at
  mock.js              Camera-free tracker for development using the same protocol
  vendor/              three.js 0.186.1 and OrbitControls, vendored (never load from a CDN)
tests/                 Python and Node tests (see "Milestone 2 checks" and "Milestone 4 checks")
```

Planned but not yet created: `web/locomotion.js`.

## Setup

Python 3.13 and a webcam. From this folder:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Use `.venv/bin/python -m pip`, not `.venv/bin/pip`. The existing venv was created before the folder moved, so its `pip` script points at the old path and fails.

Current MediaPipe releases (1.1.1 is installed here) no longer include the legacy `mp.solutions` API. This code uses the Tasks API (`HandLandmarker`, `FaceLandmarker`), which needs the model files `hand_landmarker.task` and `face_landmarker.task`. The hand model is committed, and the prototype downloads it again if it's missing. The face model is gitignored: the tracker downloads it (about 3.8 MB) the first time it starts with webcam gaze. **Do this once on every laptop while you have reliable internet, or copy the file over, since venue Wi-Fi may not work.** If the download fails, the hands keep working and the browser's gaze status line shows the error.

On macOS, grant the app you run from (Cursor, Terminal, iTerm) permissions in System Settings > Privacy & Security, then fully quit and reopen it:
- **Camera**, or the webcam won't open.
- **Accessibility** is needed only for the standalone prototype's OS mouse control. The browser tracker doesn't import `pynput`, open a preview window or control your mouse.

## Running the web app

From the project root, use two terminals:

```bash
# Terminal 1: webcam sensing, served only on localhost:8766
.venv/bin/python tracker/main.py

# Terminal 2: browser files
.venv/bin/python -m http.server 8000 --directory web
```

Open [localhost:8000](http://localhost:8000). `TRACKER_SOURCE = 'websocket'` is the default. The HUD changes from `connecting` / `waiting for camera` to `live`, with tracker Hz. Raise your hands to see the skeletons; thumb-index pinches produce `pinch_start` / `pinch_end` in the HUD.

### Gaze and grabbing (milestone 4)

1. Size and place the browser window the way you'll use it, sit at your normal distance, and click **Calibrate gaze**.
2. Follow the dot through its nine positions with your eyes, keeping your head comfortably still. Each point captures automatically (about 1.5 s each). **Esc** cancels. If the fit is inconsistent, the status line says why; fix lighting or posture and retry.
3. A round reticle follows your gaze. The block nearest to it gets a warm glow (the reticle turns amber). The block doesn't have to be exactly under the reticle: webcam gaze is only good to a few degrees, so targeting is forgiving (see below).
4. **Pinch** (thumb and index) while a block glows to grab it. Move your hand to move the block, then un-pinch to place it. The block turns teal while held.

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

Use `--camera 1` for a different camera or `--port 8767` for a different local port (also update `TRACKER_URL`). Close the standalone prototype before starting the browser tracker so they don't compete for the webcam. Stop the tracker with Ctrl+C.

For camera-free development, set `TRACKER_SOURCE = 'mock'` in `web/config.js`. Two animated hands sway and pinch. While `DEV_ORBIT` is on, drag to orbit, scroll to zoom, and right-drag to pan. `window.app` exposes the renderer, scene, camera, hands and latest tracker frame in the dev console.

The target is a steady 60 fps. If a large or high-DPI window drops below that, lower the pixel-ratio cap in `createRenderer()` in `scene.js` from 2 to 1.5.

### Two users (milestone 5)

The two users stand at opposite ends of the blocks, facing each other. Laptop A is the scene authority.

```bash
# Laptop A only
.venv/bin/python relay/relay.py

# Each laptop: tracker and web server as above, then open the page
#   laptop A: http://localhost:8000
#   laptop B: http://localhost:8000/?user=B&relay=ws://<laptop A's address>:8765
```

Set `RELAY_URL` in `web/config.js` to laptop A's address (or pass `relay=` in the URL), and `USER_ID` to `'B'` on the second laptop. The HUD shows `relay connected with B` once both are up.

What each user sees of the other: a blue bust at their eye position, a head that turns with theirs, their hands next to them, a violet glow on the block they are looking at, and a brighter glow on the block they are holding. Their avatar disappears 0.7 s after they stop sending.

Ownership:
- Whoever grabs a block owns it and streams its position; the other laptop only draws it. A block the other user holds can't be targeted or grabbed until they let go.
- If both grab the same block in the same instant, the lower user id keeps it (A over B) and the other laptop lets go.
- Laptop A rebroadcasts every block about 10 times a second, so a laptop that reloads or joins late catches up within a moment. If laptop A reloads, the blocks reset to the starter layout.

To try it on one laptop, run one relay and one tracker, then open two browser **windows** (not tabs: a background tab stops rendering and sending). For example `localhost:8000/?user=A&relay=ws://localhost:8765` and `localhost:8000/?user=B&relay=ws://localhost:8765`. Add `&tracker=mock` to either for camera-free animated hands. Both windows can share the one tracker, so both users' hands move together.

If the laptops can't reach each other, some venue Wi-Fi isolates clients from each other. Test this early; a phone hotspot or an ethernet cable between the laptops avoids it.

### Settings (`web/config.js`)

| Setting | Meaning |
|---|---|
| `USER_ID` | `'A'` or `'B'`, which end of the blocks you stand at. Override with `?user=B` in the page URL |
| `HOST_ID` | The scene authority, `'A'` |
| `RELAY_URL` | Laptop A's address, `ws://<address>:8765`. The default is a placeholder. Override with `?relay=...` in the page URL |
| `TRACKER_URL` | Local tracker WebSocket, `ws://localhost:8766` |
| `TRACKER_SOURCE` | `'websocket'` for the local Python tracker (default), or `'mock'`. Override with `?tracker=mock` in the page URL |
| `GAZE_SOURCE` | `'webcam'` (calibrated iris features, default), `'external'` (tracker-provided screen coordinates), or `'pointer'` (mouse, development). Ignored in mock mode, which always uses the pointer |
| `SCREEN_WIDTH_M`, `SCREEN_HEIGHT_M` | Physical screen size in meters, for the depth effect. Defaults assume a 14" MacBook Pro |
| `DEV_ORBIT` | Mouse-orbit camera for development. Turn off once head pose or the avatar drives the camera |

### Tracker data and coordinates

The browser accepts the `frame` and `gesture` messages described in `CLAUDE.md`, with these concrete conventions:

- **`lm`** is 21 landmarks per hand, in meters relative to the webcam: **x** toward the user's right (the image is mirrored), **y** down, **z** away from the webcam toward the user. This is the camera-space output of the prototype's `solvePnP` step.
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

## Running the prototype

```bash
.venv/bin/python hand_mouse.py
```

This opens a "Hand Mouse" window with the camera feed and overlays. Click the window before pressing keys; OpenCV only receives keys while its window is in front. It tracks up to two hands.

### Modes and keys

| Key | Action |
|---|---|
| `m` | Toggle mouse mode (press again to return to shapes) |
| `j` | Toggle juggle mode |
| `c` | Toggle the camera image; tracking keeps running on a dark background |
| `r` | Reset the shapes, or the juggling balls and score |
| `p` | Print the primary hand's 21 landmarks (normalized and in cm) |
| `q` / Esc | Quit |

**Shapes mode (default).** A cube and a pyramid float in the camera view.
- **One hand:** pinch thumb and index over a shape to grab it (yellow outline means grabbable, white means held). Move your hand to move it, including toward and away from the camera, and turn your hand to rotate it.
- **Two hands:** pinch the same shape with both hands, then pull apart or push together to stretch or squeeze it along the line between them (0.3x to 4x per axis). Let go with either hand and the other keeps holding it without a jump.

Rotation and depth are flipped to the user's point of view: held shapes turn the way you see your hand turn, and pushing toward the screen pushes a shape deeper.

**Mouse mode.** The palm moves the cursor through an "active box" in the frame. Thumb plus index is a left click (hold to drag), thumb plus middle is a right click. A closed fist blocks clicks.

**Juggle mode.** Three floaty balls with gravity and drag. Close a hand (fist or pinch) near a ball to catch it, and open the hand while moving to throw it with your hand's velocity. Balls bounce off the walls and a soft ceiling. Catches, streak, best streak, and drops are scored at the top.

### Indicators

- **Pinch bars** (top left) fill as each finger nears the thumb; the white tick marks the pinch threshold. Thumb plus ring and the fist are indicators only.
- **Depth bar** (right edge) shows hand-to-camera distance, 20 to 90 cm.
- **Rotation arrows** on each palm, plus roll, pitch, and yaw along the bottom, measured from the user's point of view. The bottom line also says whether the palm or the back of the hand faces the camera.
- **A gray skeleton** means tracking dropped out and the hand's last pose is being held.

### Tuning

Shared sensing constants are in `tracker/hands.py`, `tracker/gestures.py` and `tracker/filters.py`. Prototype interaction constants remain in `hand_mouse.py` and `juggle.py`.

| Constant | Effect |
|---|---|
| `CLOSE`, `OPEN` | Pinch start and release thresholds, as a fraction of hand size (wrist to middle-finger base) |
| `CAMERA_HFOV_DEG` | Webcam field of view. Depth readings scale with it, so adjust if distances look off |
| `ACTIVE_BOX` | Part of the frame that maps to the full screen in mouse mode |
| `HOLD_TIME` | How long a lost hand keeps its last pose (default 0.35 s) |
| `MIN_STRETCH`, `MAX_STRETCH` | Two-hand stretch limits |
| `pinch_filter`, `axes_filter` in `HandState` | Smoothing for held-shape position and rotation. Lower `min_cutoff` for less jitter, raise `beta` for less lag |
| `GRAVITY`, `DRAG`, `THROW_GAIN`, `CATCH_MARGIN` | Juggling feel (`juggle.py`) |

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
- **The other user sits at the top edge of the screen.** Each camera looks down at the blocks from eye height 1.6 m, so the person at the far end lands at the top of the view, small and partly under the controls panel. Lowering the seat height in `SEATS` in `web/scene.js` brings them toward the middle.
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

These cover the relay (forwards to every other client, not the sender; text passes through untouched; a leaving client doesn't affect the rest; no state kept for late joiners), the message contract and validation, sequence-number dedupe, reconnects and dropped snapshots (`net.js`), block ownership (a held block follows its holder's stream, the lower user id wins a same-instant grab, host snapshots never override a held block or pull one back right after release, quiet peers lose their holds), the avatar (placement, head rotation, easing, disappearing and reappearing in place), and the interaction rules for blocks the other user holds. Each rule was checked by deliberately breaking it and confirming a test fails.

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

## Milestone 2 checks

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test tests/tracker.test.mjs
```

These cover camera-space geometry, filtering, dropout/failed-pose expiry, pinch hysteresis, actual local WebSocket delivery and reconnects, and browser message validation/stale-feed recovery. Node is only needed for the JavaScript tests, not to run the app.

Manual completion check: show both hands, pinch/release each, briefly hide then fully remove a hand, and restart the tracker while the browser stays open. Browser rendering and reconnect/stall recovery were also exercised in headless Chrome with real MediaPipe inference on a sample hand image. The user accepted movement/responsiveness; fast motion and side-profile tracking remain the prioritized polish items above.
