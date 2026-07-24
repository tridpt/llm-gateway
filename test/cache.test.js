import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseCache } from '../src/services/cache.js';

const body = (overrides = {}) => ({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

test('keyFor is stable for identical requests', () => {
  assert.equal(ResponseCache.keyFor(body()), ResponseCache.keyFor(body()));
});

test('keyFor ignores the streaming flag', () => {
  assert.equal(
    ResponseCache.keyFor(body({ stream: true })),
    ResponseCache.keyFor(body({ stream: false })),
  );
});

test('keyFor changes when a semantically relevant field changes', () => {
  assert.notEqual(ResponseCache.keyFor(body()), ResponseCache.keyFor(body({ model: 'gpt-4o-mini' })));
  assert.notEqual(ResponseCache.keyFor(body()), ResponseCache.keyFor(body({ temperature: 0.7 })));
});

test('get returns what set stored', () => {
  const c = new ResponseCache({ ttlSeconds: 10, maxEntries: 100 });
  c.set('k', { answer: 42 });
  assert.deepEqual(c.get('k'), { answer: 42 });
  assert.equal(c.size, 1);
});

test('get returns undefined for a missing key', () => {
  const c = new ResponseCache({ ttlSeconds: 10, maxEntries: 100 });
  assert.equal(c.get('nope'), undefined);
});

test('evicts the least-recently-used entry when over capacity', () => {
  const c = new ResponseCache({ ttlSeconds: 10, maxEntries: 2 });
  c.set('a', 1);
  c.set('b', 2);
  // Touch 'a' so 'b' becomes the least-recently used.
  assert.equal(c.get('a'), 1);
  c.set('c', 3);

  assert.equal(c.size, 2);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
  assert.equal(c.get('b'), undefined);
});

test('entries expire after the TTL', async () => {
  const c = new ResponseCache({ ttlSeconds: 0.05, maxEntries: 100 });
  c.set('k', 'v');
  assert.equal(c.get('k'), 'v');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(c.get('k'), undefined);
  // A lazily-expired entry is removed from the store.
  assert.equal(c.size, 0);
});

test('clear empties the cache', () => {
  const c = new ResponseCache({ ttlSeconds: 10, maxEntries: 100 });
  c.set('a', 1);
  c.set('b', 2);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.get('a'), undefined);
});
