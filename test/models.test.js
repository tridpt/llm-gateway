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

const AUTH = { Authorization: 'Bearer demo-key-123' };

test('GET /v1/models returns an OpenAI-shaped list', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/models`, { headers: AUTH });
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.object, 'list');
  assert.ok(Array.isArray(json.data));
  assert.ok(json.data.length > 0);

  const entry = json.data[0];
  assert.ok(entry.id);
  assert.equal(entry.object, 'model');
  assert.ok(entry.owned_by);

  server.close();
});

test('GET /v1/models requires authentication', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/models`); // no auth
  assert.equal(res.status, 401);
  server.close();
});

test('model catalogue includes aliases with routing info', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/models`, { headers: AUTH });
  const json = await res.json();

  const alias = json.data.find((m) => m.id === 'fast');
  assert.ok(alias, 'expected the "fast" alias to be listed');
  assert.equal(alias.owned_by, 'alias');
  assert.ok(alias.routes_to);

  server.close();
});
