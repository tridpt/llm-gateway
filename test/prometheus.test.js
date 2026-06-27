import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.js';

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

test('/metrics returns Prometheus exposition format', async () => {
  const { server, base } = await startServer();

  // Generate some activity first.
  await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ model: 'mock-gpt', messages: [{ role: 'user', content: 'prom test' }] }),
  });

  const res = await fetch(`${base}/metrics`);
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  // Has HELP/TYPE comments and the request counter.
  assert.match(text, /# HELP llmgw_requests_total/);
  assert.match(text, /# TYPE llmgw_requests_total counter/);
  assert.match(text, /llmgw_requests_total \d+/);
  // Labelled per-model series is present.
  assert.match(text, /llmgw_model_requests_total\{model="mock-gpt"\} \d+/);

  server.close();
});

test('/metrics is reachable without authentication', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/metrics`); // no Authorization header
  assert.equal(res.status, 200);
  server.close();
});
