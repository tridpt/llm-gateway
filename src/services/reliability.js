import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Reliability primitives: timeouts, retries with backoff, and a circuit
 * breaker. These are the patterns that separate a toy proxy from something
 * you'd actually run in front of a paid API.
 */

/** HTTP status codes worth retrying — transient server/throttling errors. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Decide whether an error is transient (retry/fallback) vs. a hard client
 * error (fail fast). Provider adapters throw messages like
 * "Gemini error 429: ...", so we parse the status out of the message and also
 * treat aborts and network failures as retryable.
 */
export function isRetryable(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true; // our timeout
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') return true;
  // Native fetch network failure.
  if (err.name === 'TypeError' && /fetch failed/i.test(err.message)) return true;

  const match = /error\s+(\d{3})/i.exec(err.message || '');
  if (match) return RETRYABLE_STATUS.has(Number(match[1]));

  return false;
}

/**
 * Run `fn(signal)` with an abort-based timeout.
 */
export async function withTimeout(ms, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry `fn` on transient errors using exponential backoff with jitter.
 * Stops early (re-throws) on non-retryable errors.
 */
export async function withRetry(fn, { retries, baseMs, requestId, provider } = {}) {
  const maxRetries = retries ?? config.reliability.retryMax;
  const base = baseMs ?? config.reliability.retryBaseMs;

  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;

      // Exponential backoff: base * 2^attempt, plus up to 100ms jitter.
      const delay = base * 2 ** attempt + Math.floor(Math.random() * 100);
      logger.warn('Retrying after transient error', {
        requestId,
        provider,
        attempt: attempt + 1,
        delayMs: delay,
        error: err.message,
      });
      await sleep(delay);
      attempt += 1;
    }
  }
}

/**
 * Per-provider circuit breaker.
 *
 * States:
 *   closed   — normal, requests flow through
 *   open      — too many recent failures; requests are skipped until cooldown
 *   half-open — after cooldown, allow one trial request to test recovery
 */
class CircuitBreaker {
  constructor({ threshold, cooldownMs }) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.state = {}; // provider -> { failures, openedAt }
  }

  _get(name) {
    if (!this.state[name]) this.state[name] = { failures: 0, openedAt: 0 };
    return this.state[name];
  }

  /** Returns true if the provider should be skipped right now. */
  isOpen(name) {
    const s = this._get(name);
    if (s.failures < this.threshold) return false;

    // Cooldown elapsed → allow a half-open trial.
    if (Date.now() - s.openedAt >= this.cooldownMs) return false;
    return true;
  }

  recordSuccess(name) {
    const s = this._get(name);
    if (s.failures > 0) {
      logger.info('Circuit recovered', { provider: name });
    }
    s.failures = 0;
    s.openedAt = 0;
  }

  recordFailure(name) {
    const s = this._get(name);
    s.failures += 1;
    if (s.failures === this.threshold) {
      s.openedAt = Date.now();
      logger.warn('Circuit opened', {
        provider: name,
        cooldownMs: this.cooldownMs,
      });
    }
  }

  snapshot() {
    const out = {};
    for (const [name, s] of Object.entries(this.state)) {
      out[name] = { failures: s.failures, open: this.isOpen(name) };
    }
    return out;
  }
}

export const circuitBreaker = new CircuitBreaker({
  threshold: config.reliability.circuitThreshold,
  cooldownMs: config.reliability.circuitCooldownMs,
});
