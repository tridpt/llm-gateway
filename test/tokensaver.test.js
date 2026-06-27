import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTokenSaver } from '../src/services/tokenSaver.js';

const convo = (n) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message number ${i}`,
  }));

test('keeps only the most recent N messages', () => {
  const messages = [{ role: 'system', content: 'be helpful' }, ...convo(10)];
  const { messages: out, stats } = applyTokenSaver(messages, { maxMessages: 4 });

  // 1 system + 4 most-recent convo
  assert.equal(out.length, 5);
  assert.equal(out[0].role, 'system');
  assert.equal(out[out.length - 1].content, 'message number 9');
  assert.equal(stats.droppedMessages, 6);
});

test('always preserves system messages', () => {
  const messages = [
    { role: 'system', content: 'rules' },
    ...convo(20),
  ];
  const { messages: out } = applyTokenSaver(messages, { maxMessages: 2 });
  assert.equal(out.filter((m) => m.role === 'system').length, 1);
  assert.equal(out[0].role, 'system');
});

test('never drops the final message under a token budget', () => {
  const messages = convo(8);
  const { messages: out } = applyTokenSaver(messages, { maxInputTokens: 1 });
  assert.ok(out.length >= 1);
  assert.equal(out[out.length - 1].content, 'message number 7');
});

test('collapses whitespace when enabled', () => {
  const messages = [{ role: 'user', content: 'hello     world\n\n\n\nbye' }];
  const { messages: out } = applyTokenSaver(messages, { trimWhitespace: true });
  assert.equal(out[0].content, 'hello world\n\nbye');
});

test('reports tokens saved and does not mutate input', () => {
  const messages = [{ role: 'system', content: 'sys' }, ...convo(10)];
  const before = JSON.stringify(messages);
  const { stats } = applyTokenSaver(messages, { maxMessages: 3 });
  assert.ok(stats.tokensSaved > 0);
  assert.ok(stats.tokensAfter < stats.tokensBefore);
  assert.equal(JSON.stringify(messages), before); // input untouched
});

test('no-op when nothing to trim', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const { messages: out, stats } = applyTokenSaver(messages, { maxMessages: 12, trimWhitespace: true });
  assert.equal(out.length, 1);
  assert.equal(stats.droppedMessages, 0);
});
