import { config } from '../config.js';
import { metrics } from '../services/metrics.js';

/**
 * Sliding-window rate limiter, per gateway API key.
 *
 * Keeps an array of request timestamps per client and counts how many fall
 * within the window. Simple, accurate, and good enough for a single instance.
 * For a distributed setup you'd move this state into Redis.
 */
const windows = new Map(); // clientKey -> number[] (timestamps in ms)

export function rateLimit(req, res, next) {
  if (!config.rateLimit.enabled) return next();

  const now = Date.now();
  const windowMs = config.rateLimit.windowSeconds * 1000;
  const key = req.clientKey || 'anonymous';

  const timestamps = (windows.get(key) || []).filter((t) => now - t < windowMs);

  if (timestamps.length >= config.rateLimit.maxRequests) {
    metrics.recordRateLimited();
    const retryAfter = Math.ceil(
      (windowMs - (now - timestamps[0])) / 1000
    );
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: {
        message: `Rate limit exceeded: ${config.rateLimit.maxRequests} requests per ${config.rateLimit.windowSeconds}s.`,
        type: 'rate_limit_error',
        retry_after_seconds: retryAfter,
      },
    });
  }

  timestamps.push(now);
  windows.set(key, timestamps);

  res.set('X-RateLimit-Limit', String(config.rateLimit.maxRequests));
  res.set('X-RateLimit-Remaining', String(config.rateLimit.maxRequests - timestamps.length));

  next();
}
