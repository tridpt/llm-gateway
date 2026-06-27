import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * In-memory response cache with TTL and a max-entry bound.
 *
 * Keyed by a hash of the semantically relevant request fields, so two
 * identical chat requests share a cached answer. This is the single biggest
 * cost/latency win a gateway provides.
 *
 * Note: in-memory only. For multi-instance deployments you would back this
 * with Redis, but the interface here would stay the same.
 */
class ResponseCache {
  constructor({ ttlSeconds, maxEntries }) {
    this.ttlMs = ttlSeconds * 1000;
    this.maxEntries = maxEntries;
    this.store = new Map(); // key -> { value, expiresAt }
  }

  static keyFor(body) {
    // Only hash fields that affect the output. Streaming flag is ignored so a
    // streamed and non-streamed request can share the same cached content.
    const relevant = {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature ?? null,
      top_p: body.top_p ?? null,
      max_tokens: body.max_tokens ?? null,
    };
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(relevant))
      .digest('hex');
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Refresh LRU ordering: re-insert to mark as most-recently used.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });

    // Evict oldest entries when over capacity.
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

export const cache = new ResponseCache({
  ttlSeconds: config.cache.ttlSeconds,
  maxEntries: config.cache.maxEntries,
});
