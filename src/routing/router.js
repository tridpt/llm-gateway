import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { latencyTracker } from '../services/latency.js';

/**
 * Smart router. Turns a requested model name into an ordered list of concrete
 * route targets ({ provider, model, tier }) that form the fallback chain.
 *
 * Features:
 *  - Aliases:        "fast" / "smart" → a real model name
 *  - Tiered routing: targets grouped by tier; tiers tried in configured order
 *                    (e.g. free → cheap → premium)
 *  - Load balancing: weighted round-robin among same-tier targets
 *  - Latency routing: when strategy = "latency", same-tier targets are ordered
 *                    by observed EWMA latency (fastest first; unmeasured first)
 *
 * Config shape (routes.json):
 * {
 *   "strategy": "tier" | "latency",
 *   "tiers": ["free", "cheap", "premium"],
 *   "aliases": { "fast": "gemini-2.5-flash-lite" },
 *   "models": {
 *     "gemini-2.5-flash-lite": [
 *       { "provider": "gemini", "model": "gemini-2.5-flash-lite", "tier": "free", "weight": 1 },
 *       { "provider": "mock",   "model": "mock-gpt",              "tier": "premium" }
 *     ]
 *   }
 * }
 */
export class Router {
  constructor(routeConfig = {}, { latency = latencyTracker } = {}) {
    this.strategy = routeConfig.strategy || 'tier';
    this.tiers = routeConfig.tiers || [];
    this.aliases = routeConfig.aliases || {};
    this.models = routeConfig.models || {};
    this.latency = latency;
    this.rrCounters = new Map(); // group key -> counter for round-robin
  }

  /** Resolve an alias to its canonical model name (one level). */
  resolveAlias(name) {
    return this.aliases[name] || name;
  }

  _tierRank(tier) {
    const i = this.tiers.indexOf(tier);
    return i === -1 ? this.tiers.length : i; // unknown tiers go last
  }

  /**
   * Build the ordered target list for a request.
   *
   * @param {string} requestedModel
   * @param {string[]} availableProviders - provider names that are configured
   *        and support the needed capability
   * @returns {Array<{provider, model, tier}>}
   */
  resolveTargets(requestedModel, availableProviders = []) {
    const canonical = this.resolveAlias(requestedModel);
    const available = new Set(availableProviders);

    let targets = this.models[canonical];

    if (!targets || targets.length === 0) {
      // Default behaviour (no explicit route): try each available provider with
      // the requested model name, preserving PROVIDER_ORDER. This keeps the
      // gateway working for any model without per-model config.
      return availableProviders.map((provider) => ({
        provider,
        model: canonical,
        tier: 'default',
      }));
    }

    // Keep only targets whose provider is usable right now.
    targets = targets
      .map((t) => ({ provider: t.provider, model: t.model || canonical, tier: t.tier || 'default', weight: t.weight || 1 }))
      .filter((t) => available.has(t.provider));

    return this._order(targets, canonical);
  }

  _order(targets, canonical) {
    // Group by tier, ordered by configured tier preference.
    const byTier = new Map();
    for (const t of targets) {
      const rank = this._tierRank(t.tier);
      if (!byTier.has(rank)) byTier.set(rank, []);
      byTier.get(rank).push(t);
    }

    const ranks = [...byTier.keys()].sort((a, b) => a - b);
    const ordered = [];

    for (const rank of ranks) {
      const group = byTier.get(rank);
      ordered.push(...this._orderWithinTier(group, `${canonical}:${rank}`));
    }
    return ordered;
  }

  _orderWithinTier(group, groupKey) {
    if (group.length === 1) return group;

    if (this.strategy === 'latency') {
      // Fastest first. Unmeasured targets (null) are tried first to gather data.
      return [...group].sort((a, b) => {
        const la = this.latency.get(a.provider, a.model);
        const lb = this.latency.get(b.provider, b.model);
        if (la === null && lb === null) return 0;
        if (la === null) return -1;
        if (lb === null) return 1;
        return la - lb;
      });
    }

    // Default: weighted round-robin. Expand by weight, then rotate by a
    // per-group counter so consecutive requests spread across targets.
    const expanded = [];
    for (const t of group) {
      for (let i = 0; i < (t.weight || 1); i++) expanded.push(t);
    }
    const counter = this.rrCounters.get(groupKey) || 0;
    this.rrCounters.set(groupKey, counter + 1);
    const start = counter % expanded.length;
    const rotated = [...expanded.slice(start), ...expanded.slice(0, start)];

    // De-duplicate while preserving order (weights only affect first pick odds).
    const seen = new Set();
    const result = [];
    for (const t of rotated) {
      const key = `${t.provider}:${t.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(t);
      }
    }
    return result;
  }

  describe() {
    return {
      strategy: this.strategy,
      tiers: this.tiers,
      aliases: this.aliases,
      models: Object.fromEntries(
        Object.entries(this.models).map(([k, v]) => [k, v.length])
      ),
    };
  }
}

/** Load routes.json from the project root, if present. */
function loadRouteConfig() {
  const file = path.join(config.rootDir, 'routes.json');
  let routeConfig = {};
  if (fs.existsSync(file)) {
    try {
      routeConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
      logger.info('Loaded routes.json', {
        models: Object.keys(routeConfig.models || {}).length,
        aliases: Object.keys(routeConfig.aliases || {}).length,
      });
    } catch (err) {
      logger.error('Failed to parse routes.json, using defaults', { error: err.message });
    }
  }
  // Env override for strategy.
  if (process.env.ROUTING_STRATEGY) routeConfig.strategy = process.env.ROUTING_STRATEGY;
  return routeConfig;
}

export const router = new Router(loadRouteConfig());
