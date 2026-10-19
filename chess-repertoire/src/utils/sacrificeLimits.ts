/** At +1 the generators switch to objective conversion instead of this interval. */
export function sacrificeLimits(evaluation: number, configuredMaximum: number, configuredMinimum = 0) {
  const maximum = evaluation >= 1 ? configuredMaximum
    : Math.min(configuredMaximum, Math.max(0.15, 1 - evaluation));
  // A minimum that no longer fits must not force an exact-boundary sacrifice.
  const minimum = configuredMinimum > maximum + 1e-8 ? 0 : configuredMinimum;
  return { maximum, minimum };
}
