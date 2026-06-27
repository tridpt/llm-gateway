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

function dot(a, b) {
  return a.reduce((s, v, i) => s + v * b[i], 0);
}

test('returns OpenAI-shaped embeddings for a single string', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ model: 'mock-embed', input: 'hello world' }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.object, 'list');
  assert.equal(json.data.length, 1);
  assert.equal(json.data[0].object, 'embedding');
  assert.ok(Array.isArray(json.data[0].embedding));
  assert.ok(json.data[0].embedding.length > 0);
  server.close();
});

test('supports batch input (array of strings)', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ model: 'mock-embed', input: ['a', 'b', 'c'] }),
  });
  const json = await res.json();
  assert.equal(json.data.length, 3);
  assert.deepEqual(json.data.map((d) => d.index), [0, 1, 2]);
  server.close();
});

test('embeddings are deterministic and unit-normalized', async () => {
  const { server, base } = await startServer();
  const make = (input) =>
    fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ model: 'mock-embed', input }),
    }).then((r) => r.json());

  const v1 = (await make('same text')).data[0].embedding;
  const v2 = (await make('same text')).data[0].embedding;
  assert.deepEqual(v1, v2); // deterministic

  // L2 norm ~= 1
  const norm = Math.sqrt(dot(v1, v1));
  assert.ok(Math.abs(norm - 1) < 1e-6);

  // Different text → different vector (self-similarity > cross-similarity)
  const v3 = (await make('completely different')).data[0].embedding;
  assert.ok(dot(v1, v2) > dot(v1, v3));
  server.close();
});

test('embedding results are cached', async () => {
  const { server, base } = await startServer();
  const payload = JSON.stringify({ model: 'mock-embed', input: 'cache this vector' });
  await fetch(`${base}/v1/embeddings`, { method: 'POST', headers: AUTH, body: payload });
  const res2 = await fetch(`${base}/v1/embeddings`, { method: 'POST', headers: AUTH, body: payload });
  const json2 = await res2.json();
  assert.equal(json2.gateway.cached, true);
  server.close();
});

test('validates embeddings request body', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ model: 'mock-embed' }), // missing input
  });
  assert.equal(res.status, 400);
  server.close();
});
