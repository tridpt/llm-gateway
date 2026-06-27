import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, withRetry, withTimeout } from '../src/services/reliability.js';

test('isRetryable: transient vs hard errors', () => {
  assert.equal(isRetryable(new Error('Gemini error 429: quota')), true);
  assert.equal(isRetryable(new Error('OpenAI error 503: unavailable')), true);
  assert.equal(isRetryable(new Error('OpenAI error 400: bad request')), false);
  assert.equal(isRetryable(new Error('OpenAI error 401: unauthorized')), false);

  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isRetryable(abort), true);
});

test('withRetry retries transient errors then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('error 503: temporary');
      return 'ok';
    },
    { retries: 3, baseMs: 1 }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry does not retry hard errors', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error('error 400: bad input');
        },
        { retries: 3, baseMs: 1 }
      ),
    /400/
  );
  assert.equal(calls, 1); // no retries
});

test('withTimeout aborts a slow operation', async () => {
  await assert.rejects(
    () =>
      withTimeout(20, (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        })
      ),
    (err) => err.name === 'AbortError'
  );
});
