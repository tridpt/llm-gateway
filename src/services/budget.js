import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Build a Prometheus label set for a budget key, escaping per the exposition
 * format (backslash, double-quote, newline). `name` is optional.
 */
function escapeLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function labelsFor(key, name) {
  const parts = [`key="${escapeLabel(key)}"`];
  if (name) parts.push(`name="${escapeLabel(name)}"`);
  return parts.join(',');
}

/**
 * Per-key budget / quota manager.
 *
 * Tracks each API key's usage for the current day (UTC) and enforces two
 * independent limits:
 *   - dailyRequests  — how many requests a key may make
 *   - dailyCostUsd   — how much estimated spend a key may incur
 *
 * Limits resolve per-key (from budgets.json) and fall back to defaults.
 * A null limit means unlimited. Usage resets automatically at UTC midnight
 * because buckets are keyed by date.
 */
export class BudgetManager {
  constructor({ defaultLimits = {}, perKey = {} } = {}, { now = () => new Date() } = {}) {
    this.defaultLimits = {
      dailyRequests: defaultLimits.dailyRequests ?? null,
      dailyCostUsd: defaultLimits.dailyCostUsd ?? null,
    };
    this.perKey = perKey;
    this.now = now;
    this.usage = new Map(); // key -> { date, requests, costUsd }
    // Optional hook: (key) => { dailyRequests, dailyCostUsd } | null.
    // Lets a runtime store (e.g. the team manager) override per-key limits
    // without this module importing it (avoids a circular dependency).
    this.limitResolver = null;
  }

  _today() {
    return this.now().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  getLimits(key) {
    const resolved = this.limitResolver ? this.limitResolver(key) : null;
    if (resolved) {
      return {
        dailyRequests: resolved.dailyRequests ?? this.defaultLimits.dailyRequests,
        dailyCostUsd: resolved.dailyCostUsd ?? this.defaultLimits.dailyCostUsd,
      };
    }
    const override = this.perKey[key] || {};
    return {
      dailyRequests: override.dailyRequests ?? this.defaultLimits.dailyRequests,
      dailyCostUsd: override.dailyCostUsd ?? this.defaultLimits.dailyCostUsd,
    };
  }

  _bucket(key) {
    const today = this._today();
    const current = this.usage.get(key);
    if (!current || current.date !== today) {
      const fresh = { date: today, requests: 0, costUsd: 0 };
      this.usage.set(key, fresh);
      return fresh;
    }
    return current;
  }

  getUsage(key) {
    const b = this._bucket(key);
    return { date: b.date, requests: b.requests, costUsd: Math.round(b.costUsd * 1e6) / 1e6 };
  }

  /**
   * Check whether a new request from `key` is allowed under current usage.
   * Does not mutate state.
   * @returns {{ allowed: boolean, reason?: string, limits, usage }}
   */
  check(key) {
    const limits = this.getLimits(key);
    const usage = this._bucket(key);

    if (limits.dailyRequests != null && usage.requests >= limits.dailyRequests) {
      return {
        allowed: false,
        reason: `Daily request quota reached (${limits.dailyRequests}/day).`,
        limits,
        usage,
      };
    }
    if (limits.dailyCostUsd != null && usage.costUsd >= limits.dailyCostUsd) {
      return {
        allowed: false,
        reason: `Daily cost budget reached ($${limits.dailyCostUsd}/day).`,
        limits,
        usage,
      };
    }
    return { allowed: true, limits, usage };
  }

  /** Count a request against the key's quota. */
  recordRequest(key) {
    this._bucket(key).requests += 1;
  }

  /** Add incurred cost against the key's budget. */
  addCost(key, costUsd) {
    if (costUsd > 0) this._bucket(key).costUsd += costUsd;
  }

  snapshot() {
    const out = {};
    for (const [key, b] of this.usage.entries()) {
      const limits = this.getLimits(key);
      out[key] = {
        date: b.date,
        requests: b.requests,
        costUsd: Math.round(b.costUsd * 1e6) / 1e6,
        limits,
      };
    }
    return out;
  }

  /**
   * Render per-key usage in Prometheus exposition format. `nameLabel` maps a
   * key to a human label (e.g. a team member name); keys with no usage today
   * are skipped. Kept here so the /metrics route can append it to the global
   * metrics without this module importing the team store.
   */
  toPrometheus(nameLabel = () => null) {
    const lines = [];
    const entries = [...this.usage.entries()];
    if (!entries.length) return '';

    lines.push('# HELP llmgw_budget_requests_used Requests used today per key');
    lines.push('# TYPE llmgw_budget_requests_used gauge');
    for (const [key, b] of entries) {
      lines.push(`llmgw_budget_requests_used{${labelsFor(key, nameLabel(key))}} ${b.requests}`);
    }

    lines.push('# HELP llmgw_budget_cost_usd_used Estimated USD cost used today per key');
    lines.push('# TYPE llmgw_budget_cost_usd_used gauge');
    for (const [key, b] of entries) {
      const cost = Math.round(b.costUsd * 1e6) / 1e6;
      lines.push(`llmgw_budget_cost_usd_used{${labelsFor(key, nameLabel(key))}} ${cost}`);
    }

    return lines.join('\n') + '\n';
  }

  reset() {
    this.usage.clear();
  }
}

/** Load per-key budgets from budgets.json at the project root, if present. */
function loadBudgetConfig() {
  const file = path.join(config.rootDir, 'budgets.json');
  let perKey = {};
  let defaultLimits = {
    dailyRequests: config.budget.defaultDailyRequests,
    dailyCostUsd: config.budget.defaultDailyCostUsd,
  };

  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      perKey = parsed.keys || {};
      if (parsed.default) {
        defaultLimits = {
          dailyRequests: parsed.default.dailyRequests ?? defaultLimits.dailyRequests,
          dailyCostUsd: parsed.default.dailyCostUsd ?? defaultLimits.dailyCostUsd,
        };
      }
      logger.info('Loaded budgets.json', { keys: Object.keys(perKey).length });
    } catch (err) {
      logger.error('Failed to parse budgets.json, using defaults', { error: err.message });
    }
  }

  return { defaultLimits, perKey };
}

export const budgetManager = new BudgetManager(loadBudgetConfig());
