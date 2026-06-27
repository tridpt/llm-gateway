/**
 * Tracks a smoothed (EWMA) response latency per route target, so the router
 * can prefer the provider/model that has been responding fastest.
 *
 * EWMA (exponential weighted moving average) reacts to recent changes while
 * still smoothing out noise: newAvg = alpha * sample + (1 - alpha) * oldAvg.
 */
class LatencyTracker {
  constructor(alpha = 0.3) {
    this.alpha = alpha;
    this.stats = new Map(); // key -> { ewmaMs, samples }
  }

  static key(provider, model) {
    return `${provider}:${model}`;
  }

  record(provider, model, ms) {
    const key = LatencyTracker.key(provider, model);
    const prev = this.stats.get(key);
    const ewmaMs = prev ? this.alpha * ms + (1 - this.alpha) * prev.ewmaMs : ms;
    this.stats.set(key, { ewmaMs, samples: (prev?.samples || 0) + 1 });
  }

  /**
   * Returns the smoothed latency for a target, or Infinity-like sentinel when
   * unknown. We return null for "unknown" so the router can decide to try
   * unmeasured targets first (to gather data).
   */
  get(provider, model) {
    const entry = this.stats.get(LatencyTracker.key(provider, model));
    return entry ? entry.ewmaMs : null;
  }

  snapshot() {
    const out = {};
    for (const [key, s] of this.stats.entries()) {
      out[key] = { ewmaMs: Math.round(s.ewmaMs), samples: s.samples };
    }
    return out;
  }

  reset() {
    this.stats.clear();
  }
}

export const latencyTracker = new LatencyTracker();
export { LatencyTracker };
