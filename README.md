# Mirror Mirror

**A collaborative 3D workspace controlled by your eyes, hands, and voice.**

Mirror Mirror turns a webcam and a browser into a shared space for building. Look at an object to select it, pinch to pick it up, and describe new objects to create them. Explore themed environments with another person on the same local network, with live avatars and synchronized objects.

Built with Python, MediaPipe, and Three.js. The browser runs directly from static files—no frontend build step required.

## Features

- **Gaze-based selection:** nine-point webcam calibration, a gaze reticle, forgiving targeting, and a separate accuracy-validation flow.
- **Hand manipulation:** pinch to grab and move objects; use a second pinch to scale them with both hands.
- **Gesture navigation:** open-palm movement and look controls, with separate MOVE and EDIT modes to avoid conflicting gestures.
- **Voice-to-object creation:** turn spoken or typed descriptions into low-poly assemblies using Meta's Muse models.
- **Object library:** reuse built-in and generated objects, duplicate or delete scene objects, and export or import library entries.
- **Two-person collaboration:** shared object ownership, live avatars, remote selection highlights, and scene reconstruction for joining users.
- **Themed worlds:** Workshop, Enchanted Forest, Japanese Garden, Chinese City, Neon City, Cyberpunk City, and Neighbourhood presets.
- **Head-tracked perspective:** an optional depth effect makes the screen behave like a window into the scene.
- **Camera-free fallback:** use the mouse for selection and manipulation, or animated mock hands for development.

> Mirror Mirror is an experimental prototype. Webcam gaze accuracy, gesture responsiveness, and two-laptop behavior still require real-world validation. See [Limitations](#limitations).

## Requirements

- **Python 3.13** (the documented development version).
- A modern browser with WebGL support; Chrome is recommended for the end-to-end checks.
- A webcam for hand, gaze, and head tracking; optional in mouse or mock mode.
- A microphone, internet access, and a Meta Model API key for spoken object generation.
- Two computers on the same reachable local network for collaboration.
- Node.js only if you want to run the JavaScript tests.

Three.js, fonts, and scene assets are served from the repository. Model API calls require internet access; local rendering and tracking do not after the tracking models are available.

## Quick start

Run all commands from the project root, the directory containing this README.

### 1. Install dependencies

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

These commands use macOS/Linux virtual-environment paths. On Windows, use `.venv\Scripts\python.exe` instead of `.venv/bin/python`.

The tracker uses `hand_landmarker.task` and `face_landmarker.task` from the project root. Missing models are downloaded automatically, so start the tracker once while online before using it offline.

### 2. Start tracking

In one terminal:

```bash
.venv/bin/python tracker/main.py
```

Grant camera access when prompted. On macOS, enable camera access for your terminal or editor under **System Settings → Privacy & Security → Camera**, then restart that application if needed.

### 3. Serve the app

In another terminal:

```bash
.venv/bin/python -m http.server 8000 --directory web
```

Open [http://localhost:8000](http://localhost:8000), choose a world, and select **Play**. The tracking status should change to `live` once the camera is producing data. The relay and voice service are optional for local exploration.

**Try it without a webcam:** open [the mouse-mode workspace](http://localhost:8000/?preset=workshop&tracker=mouse). Move the cursor over an object, then hold the left mouse button and drag to move it. Right-click the scene for mouse-look; press **Esc** to release the pointer.

## Using the workspace

### Select, grab, and scale

1. Open **Settings** to access gaze controls. Set the browser window to its intended size, then select **Calibrate gaze**.
2. Follow the dot through nine positions, keeping your head comfortably still. Each point captures automatically; **Esc** cancels.
3. Switch to **EDIT** mode with **M**. Look at an object until it highlights amber.
4. Pinch your thumb and index finger to grab it. Move your hand to reposition it, then release the pinch to place it.
5. While holding an object, pinch with your other hand and move the hands apart or together to scale it. Release the second hand to keep the new size.

Use **Validate gaze** after calibration to measure error on five held-out targets. Resizing the window invalidates calibration; recalibrate after resizing or entering full screen. Good lighting, minimal glare, and well-separated objects help with selection.

### Move with gestures

The workspace separates navigation from editing:

| Mode | Gesture behavior |
|---|---|
| **MOVE** | Right open palm controls movement: left/right to strafe, toward/away from the screen for forward/back, and up/down to fly. Left open palm controls look direction. |
| **EDIT** | Gaze selects objects; pinches grab and scale them. Palm movement does not steer the camera. |

To switch modes, make fists with both hands, then open both hands. **M** is the keyboard alternative. Closing an individual hand clutches its movement stick; reopening recenters it. Sensitivity and dead zones are adjustable in **Settings**.

### Keyboard and mouse controls

| Input | Action |
|---|---|
| Up / Down arrows | Move forward / backward |
| Left / Right arrows | Turn left / right |
| A / D | Strafe left / right |
| Space / Shift | Fly up / down |
| M | Toggle MOVE / EDIT |
| V | Toggle first- / third-person view |
| C | Toggle free camera |
| P | Toggle head-tracked depth effect |
| H | Recenter head tracking |
| R | Respawn |
| L | Toggle the object library |
| F | Duplicate the targeted object |
| Delete / Backspace | Delete the targeted object |
| T | Trigger voice recording |
| J | Toggle presentation view |
| Backtick | Toggle developer diagnostics |
| Click scene | Capture the pointer for mouse-look; right-click in mouse fallback mode |
| Esc | Release the pointer or dismiss active overlays |

## Voice-to-object generation

### Configure the service

Copy the example environment file, then edit `.env` to set your key:

```bash
cp .env.example .env
```

```dotenv
MODEL_API_KEY=your-meta-model-api-key
# Optional model overrides:
# ASR_MODEL=muse-voice-transcribe-1.0
# OBJECT_MODEL=muse-wonder-1.0
```

Start the voice service in an additional terminal:

```bash
.venv/bin/python -m voice.main
```

Keep `.env` private; it is excluded from Git. The service reads the key server-side and reloads `.env` for each request, so key changes do not require a restart. A value in `.env` takes precedence over an exported environment variable.

### Create an object

In **Build with your voice**, hold **Hold to speak**, describe an object, and release to submit. Alternatively, type a description and select **Build**. In EDIT mode, holding one fist for three seconds also triggers recording; **T** is the keyboard alternative.

Try:

- “Create a blue chair with wooden legs.”
- “Make a red table with four legs.”
- “Build a small rocket with a red nose cone and three fins.”

The transcript is editable. Generated objects appear in the workspace and are saved to the local object library. Use **Undo creation** to remove the latest creation, or open the library with **L** to reuse objects.

Spoken requests use Muse Voice Transcribe for transcription and Muse Wonder for design. Typed descriptions bypass transcription; matching library entries can be reused without a new design request. Generated geometry is validated and assembled from boxes, spheres, cylinders, and cones rather than arbitrary meshes.

**Browser origin:** serve the page at `http://localhost:8000` or `http://127.0.0.1:8000` for voice features. The voice service accepts only those origins, and microphone capture requires a secure browser context such as localhost.

## Collaborate on two computers

User **A** is the scene authority. Both computers need their own tracker for webcam input, and both users must select the same world; world selection is not synchronized.

### Computer A

Run the tracker and web server as described above, then start the relay in another terminal:

```bash
.venv/bin/python relay/relay.py
```

Open `http://localhost:8000` and choose a world.

### Computer B

Install dependencies and start its local tracker, then open:

```text
http://<A-IP>:8000/?user=B
```

The page automatically connects to A's relay on port **8765** while reading B's tracker from B's own localhost. On macOS, A can find its Wi-Fi address with `ipconfig getifaddr en0` or in network settings. Allow incoming connections to ports **8000** and **8765** on A.

**For voice generation on B**, run B's own web server and voice service and open:

```text
http://localhost:8000/?user=B&relay=ws://<A-IP>:8765
```

Only computers generating new objects need an API key and voice service. The other user can see and manipulate shared objects without either.

Objects have one holder at a time. If both users grab the same object simultaneously, A wins the conflict. Joining or reconnecting users receive the host's current scene, but **reloading A resets the shared scene**.

To test collaboration on one computer, run one relay and open two browser **windows**, not background tabs:

```text
http://localhost:8000/?preset=workshop&user=A&tracker=mouse
http://localhost:8000/?preset=workshop&user=B&tracker=mouse
```

Some Wi-Fi networks isolate clients. If the computers cannot reach each other, use a network that permits peer connections, a hotspot, or Ethernet.

## Configuration

Most browser settings live in [`web/config.js`](web/config.js). Common URL parameters are:

| Parameter | Purpose | Example |
|---|---|---|
| `preset` | Choose a world and skip the landing page | `?preset=forest` |
| `user` | Select the user identity; defaults to A | `?user=B` |
| `relay` | Override the relay WebSocket address | `?relay=ws://192.168.1.10:8765` |
| `tracker` | Select `websocket`, `mouse`, or animated `mock` input | `?tracker=mouse` |
| `set` | Override the preset world with a registered set | `?set=cyberpunk` |

Combine parameters with `&`. Available presets are listed in [`web/presets/index.json`](web/presets/index.json).

| Service | Default address |
|---|---|
| Static web server | `http://localhost:8000` |
| Local tracker | `ws://localhost:8766` |
| Local voice service | `ws://localhost:8767` |
| Shared relay | `ws://<web-server-host>:8765` |

Use `--camera 1` to select a different camera, or `--gaze none` for hand-only tracking:

```bash
.venv/bin/python tracker/main.py --camera 1 --gaze none
```

`GAZE_SOURCE` supports calibrated webcam input, external tracker coordinates, and pointer input. `PARALLAX_STRENGTH` controls the head-tracked depth effect. Tracker, gesture, and filtering parameters live in `tracker/hands.py`, `tracker/gestures.py`, `tracker/filters.py`, and `web/gestures.js`.

## Architecture

| Component | Responsibility |
|---|---|
| [`tracker/`](tracker/) | Webcam capture, MediaPipe hand and face inference, filtering, gesture classification, and a local WebSocket feed |
| [`web/`](web/) | Three.js rendering, calibration, targeting, gesture navigation, avatars, object library, and scene synchronization |
| [`voice/`](voice/) | Local audio/text requests, Meta API integration, schema validation, and primitive-assembly layout |
| [`relay/`](relay/) | Stateless WebSocket broadcast between users |
| [`tests/`](tests/) | Python, JavaScript, and two-browser end-to-end checks |

Tracking and voice run in separate processes so model requests do not block sensing. Each browser reads its local tracker directly; shared avatar and object state travels through the relay. A owns the scene state, while the current holder drives an object's transform.

## Privacy and network scope

- Webcam inference runs locally; camera frames are not sent to the relay or model API.
- Recorded audio is sent to Meta for transcription, and object descriptions are sent for design. API keys remain in the local Python service.
- The relay carries avatar/tracking state and object render data—not audio, transcripts, prompts, or API keys.
- The tracker and voice service bind to localhost. The relay listens on the network and has no authentication; use it only on a trusted LAN, not the public internet.
- The object library is stored per browser in `localStorage`. It is separate from the nonpersistent shared scene.

## Testing

Run the Python and JavaScript suites from the project root:

```bash
.venv/bin/python -m unittest discover -s tests -v
node --test tests/*.test.mjs
```

Run the separate two-browser end-to-end check:

```bash
.venv/bin/python tests/e2e/run.py
```

The end-to-end runner requires Chrome and skips if it cannot find it. Set `CHROME` to an executable path if necessary; set `E2E_OUT` to retain artifacts. Automated checks use synthetic inputs or fake model services and do not establish real-world gaze accuracy or gesture quality.

## Limitations

- **Webcam gaze is approximate.** Accuracy has not been measured on real users. Head movement, dim lighting, and glasses glare can reduce reliability; use validation and recalibrate as needed.
- **Tracking can lose fast or occluded hands.** Brief dropouts hold the last pose, but fast twists and handedness changes can still interrupt a grab.
- **Depth is estimated**, using hand geometry and a configured camera field of view rather than a depth sensor.
- **Collaboration is designed for two users on a LAN.** Real two-laptop use and remote head orientation still need live validation.
- **Scenes are not persistent.** Host reloads reset the scene; the local object library remains separate.
- **Worlds must match manually.** In-app synchronized world switching is not implemented, and scenery generally has no collision handling.
- **Voice generation needs external services.** New model-generated objects require internet and access to the configured Meta models. Follow-up edits such as “make it taller” are not supported.
- **Performance depends on scene complexity and display resolution.** Large assemblies, shadows, and high pixel ratios can reduce frame rate.

## Assets and credits

Third-party scene models and their licenses are documented in [`web/assets/CREDITS.md`](web/assets/CREDITS.md). See [`docs/cyberpunk-set.md`](docs/cyberpunk-set.md) for Cyberpunk environment details and tuning.
