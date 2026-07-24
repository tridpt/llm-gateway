import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  estimateMessagesTokens,
  computeCost,
} from '../src/services/cost.js';

test('estimateTokens uses the ~4 chars/token heuristic', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2); // ceil(5/4)
});

test('estimateMessagesTokens sums content plus per-message overhead', () => {
  const messages = [
    { role: 'user', content: 'abcd' }, // 1 + 4
    { role: 'assistant', content: 'abcd' }, // 1 + 4
  ];
  assert.equal(estimateMessagesTokens(messages), 10);
});

test('estimateMessagesTokens serializes non-string content', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
  const serialized = JSON.stringify(messages[0].content);
  assert.equal(estimateMessagesTokens(messages), estimateTokens(serialized) + 4);
});

test('computeCost applies the per-model pricing table', () => {
  // gpt-4o: $2.5 in / $10 out per 1M tokens.
  assert.equal(computeCost('gpt-4o', 1_000_000, 1_000_000), 12.5);
  assert.equal(computeCost('gpt-4o', 500_000, 0), 1.25);
});

test('the mock model is free', () => {
  assert.equal(computeCost('mock-gpt', 1_000_000, 1_000_000), 0);
});

test('unknown models fall back to conservative default pricing', () => {
  // DEFAULT_PRICING is $1 in / $3 out per 1M.
  assert.equal(computeCost('totally-unknown-model', 1_000_000, 1_000_000), 4);
});

test('prefix match maps versioned model names to the base price', () => {
  assert.equal(
    computeCost('gpt-4o-2024-08-06', 1_000_000, 0),
    computeCost('gpt-4o', 1_000_000, 0),
  );
});

test('embedding models are priced on input tokens only', () => {
  // text-embedding-3-small: $0.02 in / $0 out per 1M.
  assert.equal(computeCost('text-embedding-3-small', 1_000_000, 999_999), 0.02);
});

test('cost is rounded to six decimals', () => {
  const c = computeCost('gpt-4o', 1, 1);
  assert.equal(c, Math.round(c * 1e6) / 1e6);
});
