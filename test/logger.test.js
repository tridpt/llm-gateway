import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger, logger } from '../src/services/logger.js';

test('_entry produces a structured JSONL record', () => {
  const l = new Logger();
  const entry = l._entry('info', 'hello', { requestId: 'r1', status: 200 });

  assert.equal(entry.level, 'info');
  assert.equal(entry.message, 'hello');
  assert.equal(entry.requestId, 'r1');
  assert.equal(entry.status, 200);
  // ts is a valid ISO-8601 timestamp.
  assert.ok(!Number.isNaN(Date.parse(entry.ts)));
});

test('_entry defaults meta to an empty object', () => {
  const l = new Logger();
  const entry = l._entry('warn', 'no meta');
  assert.deepEqual(Object.keys(entry).sort(), ['level', 'message', 'ts']);
});

test('info and warn write to console.log', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  logger.info('info line', { requestId: 'abc' });
  logger.warn('warn line');

  assert.equal(log.mock.callCount(), 2);
  const [msg, tail] = log.mock.calls[0].arguments;
  assert.match(msg, /INFO info line/);
  assert.equal(tail, '(abc)');
});

test('error writes to console.error', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const log = t.mock.method(console, 'log', () => {});
  logger.error('boom', { requestId: 'e9' });

  assert.equal(err.mock.callCount(), 1);
  assert.equal(log.mock.callCount(), 0);
  const [msg] = err.mock.calls[0].arguments;
  assert.match(msg, /ERROR boom/);
});

test('the console tail is empty when no requestId is given', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  logger.info('no id');
  assert.equal(log.mock.calls[0].arguments[1], '');
});
