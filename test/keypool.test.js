import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool } from '../src/services/keypool.js';

test('round-robins across keys', () => {
  const pool = new KeyPool('p', ['k1', 'k2', 'k3'], { cooldownMs: 1000 });
  assert.equal(pool.next().key, 'k1');
  assert.equal(pool.next().key, 'k2');
  assert.equal(pool.next().key, 'k3');
  assert.equal(pool.next().key, 'k1'); // wraps around
});

test('skips a rate-limited key until cooldown elapses', async () => {
  const pool = new KeyPool('p', ['k1', 'k2'], { cooldownMs: 30 });

  // k1 hits a limit; subsequent picks should avoid it.
  pool.markRateLimited('k1');
  assert.equal(pool.next().key, 'k2');
  assert.equal(pool.next().key, 'k2'); // k1 still resting

  // After cooldown, k1 becomes usable again.
  await new Promise((r) => setTimeout(r, 40));
  const keys = new Set([pool.next().key, pool.next().key]);
  assert.ok(keys.has('k1'));
});

test('returns null when all keys are rate-limited', () => {
  const pool = new KeyPool('p', ['k1', 'k2'], { cooldownMs: 1000 });
  pool.markRateLimited('k1');
  pool.markRateLimited('k2');
  assert.equal(pool.next(), null);
});

test('markSuccess clears a key cooldown early', () => {
  const pool = new KeyPool('p', ['k1', 'k2'], { cooldownMs: 10000 });
  pool.markRateLimited('k1');
  pool.markRateLimited('k2');
  assert.equal(pool.next(), null);

  pool.markSuccess('k1');
  assert.equal(pool.next().key, 'k1');
});

test('snapshot reports total/available/resting', () => {
  const pool = new KeyPool('p', ['k1', 'k2', 'k3'], { cooldownMs: 1000 });
  pool.markRateLimited('k2');
  const snap = pool.snapshot();
  assert.equal(snap.total, 3);
  assert.equal(snap.resting, 1);
  assert.equal(snap.available, 2);
});

test('empty pool yields null and size 0', () => {
  const pool = new KeyPool('p', [], { cooldownMs: 1000 });
  assert.equal(pool.size(), 0);
  assert.equal(pool.next(), null);
});
