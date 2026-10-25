# Reference-Based Glasses Eye Tracking

## Objective

Replace the glasses prototype's pupil-center regression with a reference-based eye model, then calibrate gaze by looking at known screen targets. Preserve the existing native camera assignments, independent capture workers, browser markers, hand tracking, and webcam fallback.

Reference: [JEO Research's front-camera tracker](https://www.jeoresearch.com/eyetracking.html) and [`Orlosky3DEyeTrackerFrontCamera.py`](https://github.com/JEOresearch/EyeTracker/tree/main/FrontCameraTracker).

This document describes new work. The checkpoint on `hardware_support` contains camera integration, browser markers, a 2D prototype, and validation tools; it does not yet contain the reference eye estimator.

## Camera Roles

- **Eye camera:** pupil ellipse, detection quality, estimated eye center, and 3D gaze direction.
- **Forward glasses camera:** locate browser markers and map gaze from the forward image into the viewport as the head turns.
- **Laptop webcam:** hands, avatar/head effects, and other existing functionality. Do not use its face estimate to substitute for the glasses' screen reference.

Corner markers establish the screen reference. Calibration dots provide the known points the user actually looks at.

## 1. Pupil Detection and Glare Handling

The current detector already converts to grayscale. Grayscale does not remove reflections.

- Identify small bright reflections in the eye region.
- Repair only small interior holes in the segmentation mask; do not invent a missing pupil boundary.
- Exclude glare-contaminated contour points during fitting.
- Measure boundary support, contrast, clipping, ellipse fit and occlusion.
- Reject frames with excessive glare, insufficient illumination, blinks or clipped pupils.
- Preserve nested-pupil rejection of larger iris candidates.
- Make pupil, reflection and crop diagnostics visible in local previews.

## 2. Reference Eye Model

Implement pure geometry in `tracker/eye_model.py`:

1. Collect trustworthy pupil ellipses across varied eye directions.
2. Estimate projected eye center from intersections of ellipse-normal lines, following the reference's geometric construction.
3. Reject nearly parallel intersections, circular-ellipse orientation ambiguity, outliers and insufficient motion.
4. Expose model readiness and stability rather than initializing a fake center.
5. Freeze the model before target calibration.
6. Compute normalized gaze direction using the reference ray/sphere construction.

Use explicit image-coordinate conventions, including crop offsets and image dimensions. Preserve the reference's core math; isolate deliberate numerical/robustness improvements and verify them with tests. Attribute adapted source and retain its license.

The reference uses assumed camera projection and an arbitrary sphere/camera scale. Its direction estimator is not a metric reconstruction of the eye or a calibrated eye-to-scene-camera transform. Do not label those coordinates as meters.

## 3. Calibration by Looking at Screen Targets

### Learn the eye model

Show an on-screen warmup guide. Ask the user to look around the display until enough diverse, stable ellipse observations have accumulated. Display learning/ready/locked status.

### Lock and calibrate

- Lock the eye model, confirm its revision, then present known screen targets.
- Pair every accepted direction with its actual target and the time-aligned forward-camera screen mapping.
- Map the browser target into forward-image coordinates using that observation's inverse screen homography.
- Fit a tangent-plane direction-to-forward-image map, preserving the reference's orientation/basis approach while supporting the browser's target sequence.
- Do not reuse the webcam's four-feature regression for glasses.
- Preserve paired observations rather than independently taking medians of moving eye features and screen geometry.
- Require fresh, stable observations after each target transition; pause on invalid frames.
- Reject insufficient directional coverage or inconsistent fits, scoring errors back in viewport units.

## 4. Runtime Mapping

```text
Eye frame -> pupil ellipse -> locked eye model -> normalized gaze direction
                                                     |
                                                     v
                                      tangent-plane calibration
                                                     |
                                                     v
                                      forward-image gaze point
                                                     |
Forward frame -> browser-marker homography -----------+
                                                     |
                                                     v
                                           viewport gaze
```

The camera-to-screen reference updates continuously as the head turns. Detecting the screen and estimating the eye direction are separate quality checks; both must be valid before emitting usable gaze.

## 5. Protocol and Lifecycle

- Add eye-model learn/reset/lock commands to the existing local tracker connection.
- Carry eye-model revision/state and normalized direction alongside screen-layout revision and diagnostics.
- Ensure one browser cannot reset or release another connection's active calibration session accidentally.
- Reject stale screen layouts, eye-model revisions, replayed timestamps and obsolete calibration sessions.
- Invalidate calibration after model changes or camera assignment/orientation/crop changes.
- Freeze the eye model during calibration and use; never silently adapt its center underneath a fitted mapping.
- Preserve independent hand freshness and the webcam gaze provider.

## 6. Verification

- Numerical fixtures for the reference's gaze-vector and tangent-plane calculations.
- Synthetic ellipse sequences with a known intersection center and degenerate/outlier cases.
- Glare, iris confusion, clipping, blink and dark-image tests.
- Calibration generalization, model locking, revision changes, cancellation and stale-packet tests.
- Mutation-check key geometry, model-locking and calibration-isolation rules.
- Run the Node and Python suites and the actual Chrome/OpenCV marker smoke test.
- Keep cameras off during implementation and automated tests. Resume real capture only when requested for live validation.

Live validation must use held-out targets, not calibration fit residuals. Report mean/p90 viewport error, valid-sample rate, stationary jitter and latency. Compare a still head, head turns, sideways motion and viewing-distance changes.

## 7. Limits and Follow-Up Geometry

Reproducing the reference does not eliminate depth-dependent parallax from separation between the eye and forward camera. Accurate metric compensation requires camera intrinsics/distortion, a calibrated eye-to-forward-camera relationship and gaze-ray/screen-plane intersection. Keep this distinct from completing the reference estimator and measure the supported head-motion range before claiming accuracy.

## Workflow

1. Save and push the current integration checkpoint on `hardware_support`.
2. Branch from that checkpoint for the eye-model implementation, since it depends on the existing integration.
3. Implement the detector/model, calibration and lifecycle together, leaving a runnable application.
4. Update this document, `HARDWARE_EYE_TRACKING.md`, `README.md` and the project status with what was actually verified.
