import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * A rotating pool of API keys for a single provider.
 *
 * Why: a provider account is rate-limited per key. With several keys, the
 * gateway can round-robin across them and temporarily "rest" any key that
 * returns 429, so a busy workload keeps flowing instead of stalling. This is
 * the core trick behind routers like 9router ("never hit limits").
 *
 * A key returned to cooldown is skipped until `cooldownMs` elapses. Combined
 * with the request-level retry, a single 429 transparently rotates to another
 * key on the immediate retry.
 */
export class KeyPool {
  constructor(name, keys = [], { cooldownMs } = {}) {
    this.name = name;
    this.keys = keys;
    this.cooldownMs = cooldownMs ?? 60000;
    this.rrIndex = 0;
    this.cooldownUntil = new Map(); // key -> timestamp (ms)
  }

  size() {
    return this.keys.length;
  }

  availableCount() {
    const now = Date.now();
    return this.keys.filter((k) => (this.cooldownUntil.get(k) || 0) <= now).length;
  }

  /**
   * Pick the next usable key (round-robin), skipping keys in cooldown.
   * Returns null when every key is currently rate-limited.
   */
  next() {
    if (this.keys.length === 0) return null;
    const now = Date.now();

    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.rrIndex + i) % this.keys.length;
      const key = this.keys[idx];
      if ((this.cooldownUntil.get(key) || 0) <= now) {
        this.rrIndex = (idx + 1) % this.keys.length;
        return { key, index: idx };
      }
    }
    return null; // all keys in cooldown
  }

  markRateLimited(key) {
    this.cooldownUntil.set(key, Date.now() + this.cooldownMs);
    logger.warn('API key rate-limited, resting it', {
      provider: this.name,
      keyIndex: this.keys.indexOf(key),
      cooldownMs: this.cooldownMs,
    });
  }

  markSuccess(key) {
    if (this.cooldownUntil.has(key)) this.cooldownUntil.delete(key);
  }

  snapshot() {
    const now = Date.now();
    return {
      total: this.keys.length,
      available: this.availableCount(),
      resting: this.keys.filter((k) => (this.cooldownUntil.get(k) || 0) > now).length,
    };
  }
}

/** One pool per provider, built from config. */
export const keyPools = {
  openai: new KeyPool('openai', config.openai.apiKeys, { cooldownMs: config.keyCooldownMs }),
  anthropic: new KeyPool('anthropic', config.anthropic.apiKeys, { cooldownMs: config.keyCooldownMs }),
  gemini: new KeyPool('gemini', config.gemini.apiKeys, { cooldownMs: config.keyCooldownMs }),
};

export function keyPoolsSnapshot() {
  const out = {};
  for (const [name, pool] of Object.entries(keyPools)) {
    if (pool.size() > 0) out[name] = pool.snapshot();
  }
  return out;
}
