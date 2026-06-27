import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.js';

// Start the app on an ephemeral port for each test run.
function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const AUTH = { Authorization: 'Bearer demo-key-123', 'Content-Type': 'application/json' };

test('health endpoint responds', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/health`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  server.close();
});

test('rejects requests without a valid API key', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-gpt', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 401);
  server.close();
});

test('returns an OpenAI-shaped completion via the mock provider', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ model: 'mock-gpt', messages: [{ role: 'user', content: 'hello world' }] }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.object, 'chat.completion');
  assert.ok(json.choices[0].message.content.includes('hello world'));
  assert.ok(json.usage.total_tokens > 0);
  server.close();
});

test('second identical request is served from cache', async () => {
  const { server, base } = await startServer();
  const payload = JSON.stringify({
    model: 'mock-gpt',
    messages: [{ role: 'user', content: 'cache me please' }],
  });

  await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: AUTH, body: payload });
  const res2 = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: AUTH, body: payload });
  const json2 = await res2.json();

  assert.equal(json2.gateway.cached, true);
  server.close();
});

test('validates request body', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ model: 'mock-gpt' }), // missing messages
  });
  assert.equal(res.status, 400);
  server.close();
});

test('metrics endpoint reflects activity', async () => {
  const { server, base } = await startServer();
  await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ model: 'mock-gpt', messages: [{ role: 'user', content: 'metrics test' }] }),
  });
  const res = await fetch(`${base}/admin/metrics`, { headers: AUTH });
  const json = await res.json();
  assert.ok(json.totals.requests >= 1);
  server.close();
});
