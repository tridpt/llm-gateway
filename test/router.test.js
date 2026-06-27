import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/routing/router.js';
import { LatencyTracker } from '../src/services/latency.js';

const CONFIG = {
  strategy: 'tier',
  tiers: ['free', 'cheap', 'premium', 'fallback'],
  aliases: { fast: 'model-x', smart: 'model-y' },
  models: {
    'model-x': [
      { provider: 'gemini', model: 'gemini-flash', tier: 'free' },
      { provider: 'mock', model: 'mock-gpt', tier: 'fallback' },
    ],
    balanced: [
      { provider: 'a', model: 'm', tier: 'free', weight: 1 },
      { provider: 'b', model: 'm', tier: 'free', weight: 1 },
    ],
  },
};

test('resolves aliases to canonical model names', () => {
  const r = new Router(CONFIG);
  assert.equal(r.resolveAlias('fast'), 'model-x');
  assert.equal(r.resolveAlias('unknown'), 'unknown');
});

test('unknown model falls back to default per-provider targets', () => {
  const r = new Router(CONFIG);
  const targets = r.resolveTargets('some-model', ['gemini', 'mock']);
  assert.deepEqual(targets, [
    { provider: 'gemini', model: 'some-model', tier: 'default' },
    { provider: 'mock', model: 'some-model', tier: 'default' },
  ]);
});

test('orders targets by tier preference (free before fallback)', () => {
  const r = new Router(CONFIG);
  const targets = r.resolveTargets('fast', ['gemini', 'mock']); // alias → model-x
  assert.equal(targets[0].provider, 'gemini'); // free tier first
  assert.equal(targets[0].tier, 'free');
  assert.equal(targets[1].provider, 'mock'); // fallback tier last
});

test('filters out unavailable providers', () => {
  const r = new Router(CONFIG);
  const targets = r.resolveTargets('model-x', ['mock']); // gemini not available
  assert.equal(targets.length, 1);
  assert.equal(targets[0].provider, 'mock');
});

test('round-robin spreads same-tier targets across calls', () => {
  const r = new Router(CONFIG);
  const first = r.resolveTargets('balanced', ['a', 'b'])[0].provider;
  const second = r.resolveTargets('balanced', ['a', 'b'])[0].provider;
  // Two same-tier targets → consecutive calls should pick different leads.
  assert.notEqual(first, second);
});

test('latency strategy prefers the faster target', () => {
  const latency = new LatencyTracker();
  latency.record('a', 'm', 500); // slow
  latency.record('b', 'm', 50); // fast
  const r = new Router({ ...CONFIG, strategy: 'latency' }, { latency });
  const targets = r.resolveTargets('balanced', ['a', 'b']);
  assert.equal(targets[0].provider, 'b'); // fastest first
});

test('latency strategy tries unmeasured targets first to gather data', () => {
  const latency = new LatencyTracker();
  latency.record('a', 'm', 50); // measured & fast
  // 'b' has no measurement
  const r = new Router({ ...CONFIG, strategy: 'latency' }, { latency });
  const targets = r.resolveTargets('balanced', ['a', 'b']);
  assert.equal(targets[0].provider, 'b'); // unmeasured first
});
