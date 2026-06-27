import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetManager } from '../src/services/budget.js';

const CONFIG = {
  defaultLimits: { dailyRequests: 5, dailyCostUsd: 0.1 },
  perKey: {
    vip: { dailyRequests: 1000, dailyCostUsd: 100 },
    tiny: { dailyRequests: 2 },
  },
};

test('allows requests under the limit', () => {
  const b = new BudgetManager(CONFIG);
  assert.equal(b.check('alice').allowed, true);
  b.recordRequest('alice');
  assert.equal(b.getUsage('alice').requests, 1);
});

test('blocks when daily request quota is reached', () => {
  const b = new BudgetManager(CONFIG);
  for (let i = 0; i < 5; i++) {
    assert.equal(b.check('bob').allowed, true);
    b.recordRequest('bob');
  }
  const res = b.check('bob');
  assert.equal(res.allowed, false);
  assert.match(res.reason, /request quota/i);
});

test('blocks when daily cost budget is reached', () => {
  const b = new BudgetManager(CONFIG);
  b.addCost('carol', 0.1); // hits the 0.1 limit
  const res = b.check('carol');
  assert.equal(res.allowed, false);
  assert.match(res.reason, /cost budget/i);
});

test('per-key overrides take precedence over defaults', () => {
  const b = new BudgetManager(CONFIG);
  assert.equal(b.getLimits('vip').dailyRequests, 1000);
  // "tiny" overrides requests but inherits the default cost limit.
  assert.equal(b.getLimits('tiny').dailyRequests, 2);
  assert.equal(b.getLimits('tiny').dailyCostUsd, 0.1);
});

test('null limits mean unlimited', () => {
  const b = new BudgetManager({ defaultLimits: { dailyRequests: null, dailyCostUsd: null } });
  for (let i = 0; i < 100; i++) b.recordRequest('x');
  b.addCost('x', 9999);
  assert.equal(b.check('x').allowed, true);
});

test('usage resets when the UTC day changes', () => {
  let day = '2026-01-01T10:00:00.000Z';
  const b = new BudgetManager(CONFIG, { now: () => new Date(day) });

  for (let i = 0; i < 5; i++) b.recordRequest('dave');
  assert.equal(b.check('dave').allowed, false); // quota hit on day 1

  day = '2026-01-02T00:01:00.000Z'; // next UTC day
  assert.equal(b.check('dave').allowed, true); // fresh bucket
  assert.equal(b.getUsage('dave').requests, 0);
});
