// Held-out points deliberately differ from the nine calibration dots. Never fit on these.
export const VALIDATION_TARGETS = [
  [.3, .3], [.7, .7], [.7, .3], [.3, .7], [.5, .65],
];

export function summarizeValidation(samples, viewport) {
  if (!samples.length) throw new Error('No validation samples collected.');
  const errors = samples.map(({ prediction, target }) =>
    Math.hypot((prediction[0] - target[0]) * viewport.width,
      (prediction[1] - target[1]) * viewport.height)).sort((a, b) => a - b);
  const meanPx = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  const p90Px = errors[Math.ceil(errors.length * .9) - 1];
  return { samples: errors.length, meanPx, p90Px,
    meanScreenHeights: meanPx / viewport.height, p90ScreenHeights: p90Px / viewport.height };
}

export function recordGaze(input, target, now) {
  return {
    t: input.lastTimestamp, receivedAt: now, target: [...target],
    features: [...input.raw.features], confidence: input.raw.conf,
    head: input.head ? structuredClone(input.head) : null,
    // Score the unclamped prediction: clipping to the viewport would hide large errors.
    screen: input.raw.screen ? [...input.raw.screen] : null,
    screenLayout: input.raw.screen_layout ?? null,
    prediction: input.predictRaw(),
    filtered: input.output ? [input.output.x, input.output.y] : null,
  };
}
