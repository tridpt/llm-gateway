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

test('POST /v1/messages returns an Anthropic-shaped response', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      model: 'mock-gpt',
      max_tokens: 100,
      system: 'You are concise.',
      messages: [{ role: 'user', content: 'hello anthropic format' }],
    }),
  });
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.type, 'message');
  assert.equal(json.role, 'assistant');
  assert.ok(json.id.startsWith('msg_'));
  assert.equal(json.content[0].type, 'text');
  assert.ok(json.content[0].text.includes('hello anthropic format'));
  assert.ok(json.stop_reason);
  assert.ok(json.usage.input_tokens > 0);
  assert.ok(json.usage.output_tokens > 0);

  server.close();
});

test('accepts Anthropic block-style content', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      model: 'mock-gpt',
      max_tokens: 50,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'block content here' }] }],
    }),
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.content[0].text.includes('block content here'));
  server.close();
});

test('streams Anthropic SSE events', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({
      model: 'mock-gpt',
      max_tokens: 50,
      stream: true,
      messages: [{ role: 'user', content: 'stream please' }],
    }),
  });
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.match(text, /event: message_stop/);
  server.close();
});

test('validates the request body', async () => {
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ model: 'mock-gpt' }), // no messages
  });
  assert.equal(res.status, 400);
  server.close();
});
