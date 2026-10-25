# Task: Gesture UX (mode toggle + palm joystick)

Replace keyboard locomotion with hand gestures. Gestures write into the **same intents object** defined in `MOVEMENT_CAMERA.md`, so locomotion and camera code don't change. Keep the keyboard working as a dev fallback.

## Spec changes from MOVEMENT_CAMERA.md
- **Flying is always on.** Remove walk mode, the F toggle, and floor snapping. Vertical movement is always active, and y is clamped to ≥ 0 (you can't go through the floor).
- Add the keyboard key **M** to toggle modes (dev fallback for the gesture toggle).
- **Split the work between Python and JS.** Python classifies *static hand poses per frame*. JS owns the *temporal state machines and mappings* (toggle detection, joystick centering, curves), because tuning feel is much faster with browser hot reload. Update CLAUDE.md to say so.

## Modes
Two modes, each with its own gesture vocabulary, so gestures never conflict:
- **MOVE:** the open palm acts as a joystick. Pinch does nothing.
- **EDIT:** gaze selects, pinch grabs (see CLAUDE.md). Open-palm motion does nothing.

The app starts in MOVE. Always show the current mode on the HUD (label plus an accent color tint).

## Python → JS data (add to the tracker `frame` message)
Per hand:
```json
{"side":"right","pose":"open|fist|pinch|other","pose_conf":0.0-1.0,
 "palm":{"x":0.5,"y":0.5,"scale":0.12}}
```
- **`palm.x`, `palm.y`:** the palm center (mean of landmarks 0, 5, 9, 13, 17) in normalized image coordinates. **Un-mirror the coordinates** if the webcam feed is mirrored, so that moving your hand to the right means +x.
- **`palm.scale`:** the apparent palm size (wrist-to-middle-MCP distance, landmarks 0 and 9). This is the depth proxy: it gets larger as the hand moves toward the camera.
- Apply a One Euro filter to `x`, `y`, and `scale` in Python.
- **Pose rules:**
  - `open`: all four fingers extended (each fingertip farther from the wrist than its PIP joint).
  - `fist`: all four fingers curled (each fingertip closer to the wrist than its MCP joint).
  - `pinch`: thumb tip to index tip distance < 0.3 × `scale`.
  - Report `other` when ambiguous rather than guessing.

## Gesture 1: Mode toggle (double fist → double unfist)
Implement this as a state machine in `gestures.js`:
```
IDLE    → both hands `fist` for ≥ 150 ms (fist onsets within 300 ms of each other) → ARMED
ARMED   → both hands `open` within 800 ms → FIRE (toggle mode) → COOLDOWN
ARMED   → timeout, or either hand lost → IDLE
COOLDOWN (1 s) → IDLE
```
- **Requires both hands visible.** A single fist never toggles.
- **Feedback:** when ARMED, show a HUD cue (for example, both hand icons pulse and "open to switch" appears). On FIRE, play a sound, show a full-screen color flash or banner with the new mode name, and change the accent color.
- Entering ARMED also disengages the joystick (velocity goes to zero), so you never drift while switching modes.

## Gesture 2: Palm joystick (MOVE mode)
**Which hand:** whichever hand is `open`. If both are open, use the right hand (configurable `DOMINANT`). The other hand is ignored in MOVE mode.

**Rate control, like an analog stick:** displacement from a neutral center sets *velocity*. Push forward and you keep moving until you bring your hand back to center.

**Engage and center capture**
- When the joystick hand becomes `open` (with `pose_conf` > 0.7) and stays open for 150 ms, capture the **center**: the average of `x`, `y`, and `scale` over that window. Show an "engaged" ring on the HUD.
- The center stays fixed while engaged. Don't auto-drift it, because that would break "keep moving until recenter."
- **Disengage**, decaying velocity to zero over about 150 ms, when the hand closes to a `fist`, the hand is lost, `pose_conf` drops below 0.5 for more than 100 ms, or the toggle goes ARMED.
- Re-opening the hand recaptures a fresh center. This is the clutch: users can reset a drifted neutral by making a fist and opening again.

**Axes** (normalize by the center scale so they work at any distance from the camera)
```
lateral  = (x - cx) / cs          // + right
vertical = -(y - cy) / cs         // + up (image y grows downward)
depth    = log(scale / cscale)    // + toward the camera = push forward
```

**Mapping to intents**
| Hand motion | Intent | Default full-scale displacement |
|---|---|---|
| Push toward screen / pull back | `move.forward` +1 / −1 | depth ±0.25 |
| Raise / lower | `move.vertical` +1 / −1 | vertical ±0.8 |
| Left / right | `turn` −1 / +1 (default) **or** `move.strafe` | lateral ±0.8 |

Left/right is set by `LATERAL_MODE = 'turn' | 'strafe'`, with `turn` as the default. Without a mouse, turning is needed to steer, and it feels like steering. We'll playtest both.

**Response curve per axis**
```
a = |v| < DEAD ? 0 : (|v| - DEAD) / (FULL - DEAD)
out = sign(v) * min(1, a) ^ EXPO
```
Start with `DEAD` = 0.12 for lateral and vertical and 0.05 for depth, and `EXPO` = 1.5 (fine control near center, full speed at the edge).
- **Axis isolation:** if one axis is far stronger than the others (more than 2× each other axis), scale the others by 0.5. This stops accidental drift when the user means to push straight forward. Pushing toward the camera also shifts the palm in the image, so this matters.
- Downstream, the existing velocity smoothing in locomotion handles acceleration. Don't add more lag here.

## HUD feedback (essential: the user must feel the joystick)
- A small **joystick widget** near the bottom of the screen: a ring for the dead zone, and a dot for the current lateral and vertical displacement. Depth is shown as the dot's size or as a separate fore/aft bar. Grey when disengaged, accent color when engaged.
- Direction chevrons around the widget light up proportionally to the output on each axis.
- **Ergonomics:** small displacements should be enough. The full-scale values above are tuned so users can keep their elbows near their bodies and avoid arm fatigue. Don't make them larger.

## Dev overlay additions (backtick)
Show the raw per-hand pose and confidence, palm x/y/scale, the captured center, the axis values before and after the curve, the toggle state machine state, and the current mode.

## Config (`web/config.js`)
`DOMINANT`, `LATERAL_MODE`, `DEAD_*`, `FULL_*`, `EXPO`, `ENGAGE_MS`, `TOGGLE_FIST_MS`, `TOGGLE_OPEN_WINDOW_MS`, `TOGGLE_COOLDOWN_MS`, and `AXIS_ISOLATION`. Make all of these hot-tunable. Bonus: sliders in the dev overlay.

## Acceptance checklist
- [ ] A double fist followed by a double open toggles MOVE ↔ EDIT reliably, and a single fist never does.
- [ ] Opening a palm engages and captures the center, and the HUD shows it.
- [ ] Pushing forward moves you forward continuously, and returning to center stops you.
- [ ] Raising and lowering the hand flies up and down. Left and right turn (or strafe, per config).
- [ ] A fist or a lost hand stops movement within about 150 ms, with no runaway drift.
- [ ] Pinching in MOVE mode does nothing, and an open palm in EDIT mode does nothing.
- [ ] The keyboard still works, and M toggles modes.

**Build order:** Python pose classes and palm features → dev overlay readout → toggle state machine → joystick engage and center → axes and curves → HUD widget → tuning. Tell us how to test after each step.
