# Hardware Eye-Tracking Plan

## Goal

Improve screen-relative gaze tracking using three cameras connected to the same Mac:

1. An Inomaker USB camera mounted on glasses and pointed at one eye.
2. A second USB camera mounted in the middle of the glasses and pointed forward toward the computer.
3. The laptop webcam, retaining its existing hand and head tracking responsibilities.

Use browser-rendered tracking markers in the four viewport corners as the screen reference. This replaces the original printed-bezel-marker proposal at the user's request.

Inspiration: [JEO Research — DIY Eye Tracking with a Front Camera](https://www.jeoresearch.com/eyetracking.html).

Accuracy depends on camera mounting, calibration, timing, and pupil visibility. Both attached devices have now been identified as **Innomaker-U20CAM-1080p-S1**, with 30 fps capture modes. Their IR/illumination characteristics and suitability for close-focus eye imaging still need confirmation.

## Build Status (`hardware_support`)

- Implemented: three-camera capture, native macOS device-ID selection, preview-based role assignment, rotation and eye ROI, dark-pupil detection with nested iris rejection, browser-rendered corner markers with exact viewport geometry, bounded arrival-time alignment, independent gaze delivery, windowed/fullscreen calibration, held-out validation and dataset export.
- Verified on the actual Mac: both Innomakers and FaceTime stream together, and the full tracker delivers hand frames plus independent gaze messages through a real local WebSocket. Mounted-eye snapshots exposed iris/pupil confusion and crop clipping, which were corrected. Live calibration still requires a sufficiently lit eye image and the whole marker page visible in the forward camera; real-eye gaze accuracy remains unmeasured.
- Automated verification covers identical-name device reassignment, pupil/blink and nested-iris rejection, browser layout validation/ownership, perspective screen mapping, missing/stale references, gaze/hand freshness separation, coordinate transforms and validation isolation. A real Chrome/OpenCV smoke test checks actual marker rendering at three viewport sizes and DPR changes, including visibility above the calibration overlay. Core freshness/projection rules were mutation-checked.
- Remaining: lens intrinsics/distortion calibration, metric eye model and eye-to-forward-camera extrinsics, eye-ray/screen-plane intersection for changing viewing distance, exposure-offset measurement, and mounted-eye accuracy comparison.

The runnable implementation is the **2D prototype** described below. See [README setup](README.md#innomaker-glasses-two-usb-cameras--laptop-webcam) for commands and camera alignment. No accuracy improvement or completed 3D calibration is implied by the capture smoke check.

### Difference From the JEO Estimator

The current eye estimator is **not a faithful port** of `Orlosky3DEyeTrackerFrontCamera.py`. It detects a pupil ellipse but uses its center in a four-feature 2D regression. It does not yet estimate the eye-sphere center or output the reference's 3D gaze direction.

The reference source accumulates ellipse-normal intersections (`compute_average_intersection` / `find_line_intersection`), freezes the estimated eye center during calibration, constructs a gaze direction with a ray/sphere intersection (`compute_gaze_vector`), and fits a tangent-plane direction-to-forward-camera mapping (`build_camera_calibration` / `project_gaze_to_tangent`). A faithful adaptation should preserve those stages behind the existing camera workers and browser screen reference, and validate them on held-out targets before claiming comparable accuracy.

The reference itself uses an assumed camera FOV and an arbitrary sphere/camera coordinate scale. Reproducing its model is a separate step from calibrating metric camera intrinsics/extrinsics or eliminating depth-dependent eye-to-forward-camera parallax. Neither that model nor browser markers alone guarantee an accuracy figure on these cameras.

## Camera Responsibilities

| Camera | Primary job | Output |
|---|---|---|
| Glasses eye camera | Detect the pupil in a close-up eye image | Pupil ellipse, eye/gaze features, blink and detection quality |
| Glasses forward camera | Find printed markers around the screen | Screen position and orientation relative to the glasses |
| Laptop webcam | Preserve hand tracking and existing head tracking | Hand landmarks and head pose |

The forward camera provides the direct screen-relative reference. Initially, keep the webcam's head estimate separate from gaze estimation; use it for avatars, parallax, and diagnostics rather than blending differently calibrated pose estimates.

```text
Eye USB camera ------> pupil tracking -----------+
                                                +--> time alignment
Forward USB camera --> screen-marker pose ------+         |
                                                          v
                                                calibrated screen gaze
                                                          |
Laptop webcam -------> hands + head -----------------------+
                                                          v
                                                local WebSocket
                                                          v
                                                browser gaze targeting
```

## 1. Connect and Inspect All Three Feeds

Extend `tracker/capture.py` to support independent camera configurations:

- Camera selection by role: `webcam`, `eye`, and `scene`.
- Per-camera resolution, frame rate, rotation, and flip.
- One capture thread per camera, so a slow camera cannot stall another.
- A diagnostic view showing all three feeds, actual FPS, frame age, and connection status.
- Startup validation of camera assignments: identical USB cameras may have ambiguous names or changing device indexes.

Start with modest resolutions and increase only where measurements justify it. Prioritize high frame rate and sharp pupil detail for the eye camera, and sufficient marker detail for the forward camera. Verify simultaneous USB capture on the actual Mac.

**Done when:** all three feeds run simultaneously without accumulating delay, and existing hand tracking still works normally.

## 2. Synchronize Observations Without Blocking Capture

Ordinary USB cameras cannot be assumed to expose frames simultaneously. Implement software time alignment and expose its uncertainty.

### Timestamping

Each frame should carry:

- Camera ID and sequence number.
- A timestamp from the Mac's shared monotonic clock.
- Receipt time and processing completion time.
- A device capture timestamp when the backend exposes a usable one, converted to the shared timebase as needed.

The current capture code timestamps after `cap.read()`. This is an arrival timestamp, not a guaranteed exposure timestamp. Different buffering and transport delays can introduce camera-specific offsets.

### Alignment

- Keep small, bounded histories of pupil observations and screen poses.
- Use each eye observation's timestamp as the gaze-estimation time.
- Interpolate between nearby screen poses when available; otherwise use a sufficiently recent pose.
- Reject or mark estimates degraded when the screen pose is too old.
- Keep webcam hands and head independently timestamped; gaze must not wait for them.
- Drop old work rather than queue video behind inference.
- Measure camera delay and alignment error using a shared visual timing event where practical, followed by controlled head-motion checks.

Exact exposure synchronization would require suitable hardware support.

### Independent Gaze Delivery

`TrackerServer` currently publishes gaze only alongside new hand frames. Allow fresh gaze observations to trigger transport updates independently, without presenting stale hand observations as new measurements. Adapt transport and consumer freshness handling together.

**Done when:** gaze updates continue independently of hand inference, timing diagnostics expose stale or mismatched observations, and bounded queues prevent latency growth.

## 3. Locate the Screen

The browser renders four uniquely identified markers and reports their black-square corner coordinates relative to the current viewport. Markers scale with the viewport and include white quiet zones. They stay above calibration UI and appear only in glasses mode.

Using the forward camera:

1. Detect ArUco IDs 10–13 and use all 16 corners to estimate the image-to-viewport homography (implemented).
2. Validate corner consistency and reject missing, duplicate, mirrored or inconsistent marker sets (implemented).
3. Validate browser layout messages, track their revisions/connection ownership, and invalidate old observations after resize (implemented).
4. Calibrate lens intrinsics/distortion and estimate the metric screen plane pose (remaining for the 3D version).

The markers directly identify the browser viewport, so windowed and fullscreen modes both map correctly. Use fullscreen to make markers larger in the camera view. Resize/display-mode changes update the reference and invalidate gaze calibration.

**Done when:** the screen reference remains stable during head motion, and missing or unreliable marker observations are explicitly reported.

## 4. Track the Eye and Calibrate Gaze

Adapt the JEO pupil-detection approach behind a new gaze provider:

- Eye-region selection.
- Pupil segmentation and ellipse fitting.
- Rejection of blinks, reflections, clipped pupils, and implausible fits.
- Collection of samples while the user looks at known screen targets.

### First Runnable Prototype

Calibrate eye features into forward-camera image coordinates, then map those coordinates onto the detected screen.

This establishes whether pupil detection and calibration are good enough to improve on the webcam baseline. It does not fully solve gaze under changes in viewing distance: the eye and forward camera are physically separated, so a 2D mapping can have depth-dependent error.

### Head-Motion-Capable Version

Use a calibrated eye-gaze ray and eye-to-forward-camera transform, then intersect that ray with the detected screen plane.

This requires fitting and validating the eye model and camera relationship. A pupil ellipse alone does not provide an accurate absolute gaze ray. Validate across head poses and viewing distances rather than assuming a stationary-head fit generalizes.

Repositioning either glasses camera must invalidate its calibration. Losing the pupil or screen reference must produce an explicit unavailable/degraded state instead of leaving stale gaze active.

**Done when:** held-out screen targets are accurately estimated, including across the supported head-motion and viewing-distance range.

## 5. Integrate With the Existing Application

| Area | Proposed work |
|---|---|
| `tracker/capture.py` | Configurable multi-camera capture and timestamps |
| New eye-tracking module | Pupil detection and quality measurements |
| `web/screen-markers.js`, `tracker/glasses.py` | Adaptive browser markers and image-to-viewport mapping; metric camera calibration remains planned |
| New synchronization module | Bounded histories, timestamp matching, and freshness checks |
| New glasses-gaze provider | Calibration and screen-coordinate estimation |
| `tracker/main.py` | Camera-worker lifecycle and independent sensing updates |
| `web/gaze-ui.js` | Glasses calibration, validation, and actionable status |
| `web/gaze.js`, `web/tracker.js` | Provider routing and independent observation freshness |

The browser already has an `external` gaze path accepting normalized coordinates. Reuse that output shape while adding a clear glasses-tracker identity and calibration controls.

Keep raw video local. Send gaze coordinates, quality, timestamps, hands, and head pose over the existing local WebSocket. Preserve the webcam gaze provider as a fallback.

## 6. Measure Accuracy and Responsiveness

Wire the existing held-out gaze-validation helper into the UI before tuning smoothing or target snapping.

Compare the webcam baseline against the glasses tracker using targets excluded from calibration:

- Still head.
- Left/right and up/down head turns.
- Sideways movement and changed viewing distance.
- Blinks and temporary marker occlusion.
- Glasses removed and put back on, checking whether recalibration is needed.

Report:

- Mean and p90 screen error in pixels and screen-height units.
- Angular error when physical geometry is calibrated.
- Valid-sample rate.
- Stationary jitter.
- Observation age and processing latency.
- Wrong-object selections during actual application use.

Use repeatable recorded clips for regression tests, along with synchronization and geometry tests. Mutation-check key rules, especially stale-data rejection and coordinate transforms.

**Success:** lower held-out error and fewer wrong selections than the webcam baseline, without making gaze feel slower. Set numerical acceptance targets after measuring the actual hardware.

## Implementation Order

1. Three-camera capture and diagnostic preview.
2. Reliable pupil detection and browser-marker screen tracking.
3. Time alignment and independent gaze delivery.
4. Initial screen calibration and held-out accuracy measurement.
5. Geometric compensation for head translation and viewing distance.
6. Smoothing and interaction tuning based on measured results.

Each step should leave a runnable system. As features land, update `CLAUDE.md` and `README.md` with implementation status, setup instructions, and the verification actually performed.

## Hardware Details Still Needed

- Manufacturer specifications/product links for the identified Innomaker-U20CAM-1080p-S1 cameras.
- Additional supported capture modes, beyond the verified 640×480 eye/webcam and 1280×720 forward configuration at 30 fps.
- Whether the eye camera is infrared and what illumination it provides.
- Mount orientation and whether both cameras remain rigid relative to the glasses.
- Physical display dimensions for future metric screen geometry; browser viewport marker geometry is already transmitted automatically.
