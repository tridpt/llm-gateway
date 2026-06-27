/**
 * Lightweight in-memory metrics registry.
 *
 * Tracks aggregate counters plus a small rolling window of recent requests
 * for the admin dashboard. In a real deployment these would be exported to
 * Prometheus/OpenTelemetry, but the shape of what we measure is the point.
 */
class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.totals = {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0,
      fallbacks: 0,
      rateLimited: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    this.byProvider = {}; // provider -> { requests, errors, costUsd, tokens }
    this.byModel = {}; // model -> { requests, costUsd, inputTokens, outputTokens }
    this.recent = []; // rolling window of recent request summaries
    this.maxRecent = 100;
  }

  _bump(map, key, patch) {
    if (!map[key]) map[key] = {};
    for (const [k, v] of Object.entries(patch)) {
      map[key][k] = (map[key][k] || 0) + v;
    }
  }

  recordRequest(summary) {
    this.totals.requests += 1;
    if (summary.cacheHit) this.totals.cacheHits += 1;
    else this.totals.cacheMisses += 1;
    if (summary.error) this.totals.errors += 1;
    if (summary.usedFallback) this.totals.fallbacks += 1;

    this.totals.inputTokens += summary.inputTokens || 0;
    this.totals.outputTokens += summary.outputTokens || 0;
    this.totals.costUsd += summary.costUsd || 0;

    if (summary.provider) {
      this._bump(this.byProvider, summary.provider, {
        requests: 1,
        errors: summary.error ? 1 : 0,
        costUsd: summary.costUsd || 0,
        tokens: (summary.inputTokens || 0) + (summary.outputTokens || 0),
      });
    }

    if (summary.model) {
      this._bump(this.byModel, summary.model, {
        requests: 1,
        costUsd: summary.costUsd || 0,
        inputTokens: summary.inputTokens || 0,
        outputTokens: summary.outputTokens || 0,
      });
    }

    this.recent.unshift(summary);
    if (this.recent.length > this.maxRecent) this.recent.pop();
  }

  recordRateLimited() {
    this.totals.rateLimited += 1;
  }

  snapshot() {
    const uptimeSeconds = Math.round((Date.now() - this.startedAt) / 1000);
    const totalCacheLookups = this.totals.cacheHits + this.totals.cacheMisses;
    const cacheHitRate =
      totalCacheLookups > 0
        ? Math.round((this.totals.cacheHits / totalCacheLookups) * 100)
        : 0;

    return {
      uptimeSeconds,
      totals: {
        ...this.totals,
        costUsd: Math.round(this.totals.costUsd * 1e6) / 1e6,
      },
      cacheHitRatePercent: cacheHitRate,
      byProvider: this.byProvider,
      byModel: this.byModel,
      recent: this.recent.slice(0, 20),
    };
  }

  reset() {
    const start = this.startedAt;
    Object.assign(this, new Metrics());
    this.startedAt = start;
  }
}

export const metrics = new Metrics();
