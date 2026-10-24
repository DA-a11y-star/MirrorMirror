# Task: Movement & Camera (keyboard first, gestures later)

Implement avatar movement, camera modes, flying, a dev overlay, and a free cam in `web/`. For now everything is driven by the keyboard and mouse. Hand gestures will replace the keyboard later, so **all input must go through an intent layer** (see Architecture). Follow `CLAUDE.md` conventions: plain ES modules, no build step, runnable after each step.

## Architecture
```
input.js       keyboard/mouse  →  intents  (later: gestures → same intents)
locomotion.js  intents → avatar pose (position, yaw, velocity, fly/walk state)
camera.js      avatar pose + mode → camera pose (third person / first person / free cam)
dev.js         dev overlay + helpers
```

Each frame, `input.js` produces one intents object. Nothing downstream reads keys directly.
```js
{
  move: { forward: -1..1, strafe: -1..1, vertical: -1..1 },  // continuous
  turn: -1..1,                    // yaw rate input
  look: { dYaw, dPitch },         // mouse deltas this frame (radians)
  zoom: delta,                    // scroll
  toggles: { fly, view, freeCam, dev, depthFx, reset }  // edge-triggered, true for one frame
}
```

## Controls
| Key | Play mode (avatar) | Free cam |
|---|---|---|
| ↑ / ↓ | Walk forward / back along facing | Fly forward / back along camera look |
| ← / → | Turn avatar (yaw) | Turn camera (yaw) |
| A / D | Strafe left / right | Strafe left / right |
| Space / Shift | Up / down (fly mode only) | Up / down |
| Mouse (click canvas to pointer-lock, Esc releases) | Look around: yaw turns the avatar, pitch tilts the camera | Look around |
| Scroll | Third-person zoom distance | Fly speed |
| F | Toggle walk ↔ fly | — |
| V | Toggle third person ↔ first person | — |
| C | Enter / exit free cam | Exit free cam |
| \` (backtick) | Toggle dev overlay | Toggle dev overlay |
| P | Toggle depth (off-axis) effect | Toggle depth effect |
| R | Respawn avatar at origin | Snap free cam to avatar |

Input details: use `event.code` (layout-independent), keep a held-keys set, `preventDefault` on arrows and Space (stops page scroll), and clear held keys on `window.blur`.

## Movement feel (tune these numbers; they're starting points)
- **Frame-rate independent:** use `dt` from `THREE.Clock`, clamped to ≤ 0.05 s.
- **Smoothed velocity, not instant:** `vel = lerp(vel, target, 1 - exp(-k·dt))` with k ≈ 10 for acceleration and stopping.
- **Speeds:** walk 2 m/s, fly 4 m/s, free cam 6 m/s by default (scroll scales it 0.5×–4×).
- **Turning:** turn rate 120°/s, also smoothed.
- **Pitch:** clamp to ±85°.
- **Walk mode:** clamp avatar y to the floor (y = 0). No gravity physics needed, just snap back to the floor when leaving fly mode, with a short ease.
- **Fly mode:** no gravity. Space and Shift move vertically, and the avatar bobs slightly when hovering.
- **Collisions:** avatars pass through blocks for v1. Keep the avatar within a world bound of ±20 m.
- **Avatar animation:** a little body bob or lean in the direction of motion, and the body yaw eases toward the movement direction. Cheap, and it makes the character feel alive.

## Camera modes
- **Third person (default):** the camera trails behind and above the avatar using a spring (smooth position and look-at lag, not rigidly attached). Zoom ranges 1.5–8 m. Mouse pitch orbits the camera vertically around the avatar. Keep the camera above the floor.
- **First person:** the camera sits at avatar head height. Hide the avatar's head mesh, but keep the hands visible.
- **Free cam (C):** detaches into a separate camera that flies freely in its own frame. The avatar stops receiving movement intents but stays in place and keeps broadcasting its state to the relay (the other user still sees it). Exiting smoothly lerps (~0.4 s) back to the avatar's camera. Free cam is local only and never networked.
- **Mode switches:** always ease over ~0.3 s, never cut.
- **Depth effect:** the off-axis projection from `offaxis.js` composes *on top of* whatever camera is active. The rig provides the base pose, and the tracked eye position offsets it in camera-local space. With no tracker connected, fall back to a normal perspective camera.

## Dev mode (backtick)
Shows a corner overlay (plain DOM is fine) plus scene helpers. Local only.
- **Overlay:** FPS, frame time, mode (walk/fly, view, free cam), avatar position and yaw, camera position, current intents, tracker connection and age of the last tracker frame in ms, relay connection and peer count, and gaze target id.
- **Scene helpers:** grid, axes at the origin, the gaze ray, block ids as labels, and the camera spring target.
- Dev mode and free cam are independent and can be on at the same time.

## Networking
The avatar `state` message sends position, yaw, head pitch, and fly state. Remote avatars run the same bob and lean animation locally from their received velocity, so they look alive without extra data.

## Acceptance checklist
- [ ] Walk, turn, and strafe with smooth acceleration and stops. No jitter at 60 fps.
- [ ] Mouse look in all modes, with clamped pitch.
- [ ] F toggles fly. Space and Shift work, and landing eases to the floor.
- [ ] V switches views smoothly. Scroll zooms in third person.
- [ ] C enters and exits free cam. The avatar stays visible to the peer, and exit eases back.
- [ ] Backtick shows the overlay with live numbers.
- [ ] R respawns the avatar.
- [ ] No keyboard reads outside `input.js`.

Build in this order: input.js → walk + third-person camera → mouse look → fly → first person → free cam → dev overlay. Tell us how to test after each step.
