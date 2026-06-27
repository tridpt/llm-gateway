import { config } from '../config.js';
import { budgetManager } from '../services/budget.js';
import { metrics } from '../services/metrics.js';

/**
 * Enforce per-key daily quota and cost budget before a request is processed.
 *
 * Runs after authentication (needs req.clientKey). Rejected requests return
 * HTTP 429 with a Retry-After pointing at the next UTC day. Allowed requests
 * are counted immediately (so the request quota is enforced even for cached or
 * failed requests); incurred cost is added later by the route once known.
 */
export function budgetGuard(req, res, next) {
  if (!config.budget.enabled) return next();

  const key = req.clientKey || 'anonymous';
  const { allowed, reason, limits, usage } = budgetManager.check(key);

  // Surface current usage so clients can self-throttle.
  if (limits.dailyRequests != null) {
    res.set('X-Budget-Requests-Limit', String(limits.dailyRequests));
    res.set('X-Budget-Requests-Used', String(usage.requests));
  }
  if (limits.dailyCostUsd != null) {
    res.set('X-Budget-Cost-Limit', String(limits.dailyCostUsd));
    res.set('X-Budget-Cost-Used', String(Math.round(usage.costUsd * 1e6) / 1e6));
  }

  if (!allowed) {
    metrics.recordRateLimited();
    // Seconds until the next UTC midnight (when the budget resets).
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    res.set('Retry-After', String(Math.ceil((tomorrow - now) / 1000)));
    return res.status(429).json({
      error: {
        message: reason,
        type: 'budget_exceeded',
        usage: { requests: usage.requests, costUsd: Math.round(usage.costUsd * 1e6) / 1e6 },
        limits,
      },
    });
  }

  budgetManager.recordRequest(key);
  req.budgetKey = key;
  next();
}
