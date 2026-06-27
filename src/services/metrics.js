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

  /**
   * Render metrics in the Prometheus text exposition format so a Prometheus
   * server (or Grafana Agent, etc.) can scrape GET /metrics.
   * Metric names are prefixed with `llmgw_` and follow Prometheus conventions
   * (counters end in _total).
   */
  toPrometheus() {
    const t = this.totals;
    const lines = [];

    const metric = (name, help, type, value, labels) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      if (labels) {
        for (const [labelStr, v] of value) {
          lines.push(`${name}{${labelStr}} ${v}`);
        }
      } else {
        lines.push(`${name} ${value}`);
      }
    };

    metric('llmgw_uptime_seconds', 'Gateway uptime in seconds', 'gauge', Math.round((Date.now() - this.startedAt) / 1000));
    metric('llmgw_requests_total', 'Total requests handled', 'counter', t.requests);
    metric('llmgw_cache_hits_total', 'Total cache hits', 'counter', t.cacheHits);
    metric('llmgw_cache_misses_total', 'Total cache misses', 'counter', t.cacheMisses);
    metric('llmgw_errors_total', 'Total failed requests', 'counter', t.errors);
    metric('llmgw_fallbacks_total', 'Total requests served via fallback provider', 'counter', t.fallbacks);
    metric('llmgw_rate_limited_total', 'Total requests rejected by rate limiting', 'counter', t.rateLimited);
    metric('llmgw_input_tokens_total', 'Total prompt/input tokens', 'counter', t.inputTokens);
    metric('llmgw_output_tokens_total', 'Total completion/output tokens', 'counter', t.outputTokens);
    metric('llmgw_cost_usd_total', 'Total estimated cost in USD', 'counter', Math.round(t.costUsd * 1e6) / 1e6);

    // Per-provider request counts (labelled).
    const providerRows = Object.entries(this.byProvider).map(([name, s]) => [
      `provider="${name}"`,
      s.requests || 0,
    ]);
    if (providerRows.length) {
      metric('llmgw_provider_requests_total', 'Requests per provider', 'counter', providerRows, true);
    }

    // Per-model request counts (labelled).
    const modelRows = Object.entries(this.byModel).map(([name, s]) => [
      `model="${name}"`,
      s.requests || 0,
    ]);
    if (modelRows.length) {
      metric('llmgw_model_requests_total', 'Requests per model', 'counter', modelRows, true);
    }

    return lines.join('\n') + '\n';
  }
}

export const metrics = new Metrics();
