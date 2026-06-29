import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.js';
import { team } from '../src/services/team.js';

function startServer() {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const ADMIN = { Authorization: 'Bearer demo-key-123' };
const bearer = (key) => ({ Authorization: 'Bearer ' + key });

/** Reset the shared team store for test isolation. */
function clearTeam() {
  for (const m of team.list()) team.remove(m.key);
}

test('env GATEWAY key is treated as admin on /v1/me', async () => {
  clearTeam();
  const { server, base } = await startServer();
  const res = await fetch(`${base}/v1/me`, { headers: ADMIN });
  const me = await res.json();
  assert.equal(res.status, 200);
  assert.equal(me.admin, true);
  assert.equal(me.key, 'demo-key-123');
  server.close();
});

test('admin can create a member who can authenticate and chat', async () => {
  clearTeam();
  const { server, base } = await startServer();

  const create = await fetch(`${base}/admin/team`, {
    method: 'POST',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice', dailyRequests: 5 }),
  });
  assert.equal(create.status, 201);
  const { member } = await create.json();
  assert.match(member.key, /^sk-team-/);
  assert.equal(member.username, 'alice');
  assert.ok(member.password);

  // The new member sees themselves as a non-admin with their server name + limit.
  const me = await (await fetch(`${base}/v1/me`, { headers: bearer(member.key) })).json();
  assert.equal(me.admin, false);
  assert.equal(me.name, 'Alice');
  assert.equal(me.limits.dailyRequests, 5);

  // …and can actually use the chat endpoint.
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...bearer(member.key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 200);
  server.close();
});

test('member can sign in with username/password and use the session token', async () => {
  clearTeam();
  const { server, base } = await startServer();

  const create = await fetch(`${base}/admin/team`, {
    method: 'POST',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Login User', username: 'login.user', password: 'pass-12345' }),
  });
  assert.equal(create.status, 201);
  const { member } = await create.json();

  const login = await fetch(`${base}/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'login.user', password: 'pass-12345' }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.match(session.token, /^gw-session-v1\./);
  assert.equal(session.member.key, member.key);

  const me = await (await fetch(`${base}/v1/me`, { headers: bearer(session.token) })).json();
  assert.equal(me.key, member.key);
  assert.equal(me.username, 'login.user');
  assert.equal(me.authType, 'session');

  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...bearer(session.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 200);

  server.close();
});

test('disabled members cannot use existing session tokens', async () => {
  clearTeam();
  const m = team.create({ name: 'Session User', username: 'session.user', password: 'pass-12345' });
  const { server, base } = await startServer();

  const login = await fetch(`${base}/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: m.username, password: 'pass-12345' }),
  });
  const session = await login.json();

  await fetch(`${base}/admin/team/${encodeURIComponent(m.key)}`, {
    method: 'PATCH',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  });

  const after = await fetch(`${base}/v1/me`, { headers: bearer(session.token) });
  assert.equal(after.status, 401);
  server.close();
});

test('POST /admin/team requires a name', async () => {
  clearTeam();
  const { server, base } = await startServer();
  const res = await fetch(`${base}/admin/team`, {
    method: 'POST',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dailyRequests: 5 }),
  });
  assert.equal(res.status, 400);
  server.close();
});

test('active non-admin member cannot manage the team (403)', async () => {
  clearTeam();
  const member = team.create({ name: 'Bob' });
  const { server, base } = await startServer();
  const res = await fetch(`${base}/admin/team`, { headers: bearer(member.key) });
  assert.equal(res.status, 403);
  server.close();
});

test('an admin-flagged member can manage the team', async () => {
  clearTeam();
  const boss = team.create({ name: 'Boss', admin: true });
  const { server, base } = await startServer();
  const res = await fetch(`${base}/admin/team`, { headers: bearer(boss.key) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.members.some((m) => m.key === boss.key));
  server.close();
});

test('disabled member is rejected with 401', async () => {
  clearTeam();
  const m = team.create({ name: 'Carol' });
  const { server, base } = await startServer();

  // Admin disables them.
  const patch = await fetch(`${base}/admin/team/${encodeURIComponent(m.key)}`, {
    method: 'PATCH',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(patch.status, 200);

  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...bearer(m.key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(chat.status, 401);
  server.close();
});

test('PATCH updates limits, reflected in /v1/me', async () => {
  clearTeam();
  const m = team.create({ name: 'Dee', dailyRequests: 1 });
  const { server, base } = await startServer();

  await fetch(`${base}/admin/team/${encodeURIComponent(m.key)}`, {
    method: 'PATCH',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dailyRequests: 42 }),
  });

  const me = await (await fetch(`${base}/v1/me`, { headers: bearer(m.key) })).json();
  assert.equal(me.limits.dailyRequests, 42);
  server.close();
});

test('DELETE removes a member and revokes access', async () => {
  clearTeam();
  const m = team.create({ name: 'Eve' });
  const { server, base } = await startServer();

  const del = await fetch(`${base}/admin/team/${encodeURIComponent(m.key)}`, {
    method: 'DELETE',
    headers: ADMIN,
  });
  assert.equal(del.status, 200);

  // The key no longer authenticates.
  const after = await fetch(`${base}/v1/me`, { headers: bearer(m.key) });
  assert.equal(after.status, 401);

  // Deleting again is a 404.
  const del2 = await fetch(`${base}/admin/team/${encodeURIComponent(m.key)}`, {
    method: 'DELETE',
    headers: ADMIN,
  });
  assert.equal(del2.status, 404);
  server.close();
});

test('conversations are private to the owning key', async () => {
  clearTeam();
  const a = team.create({ name: 'UserA' });
  const b = team.create({ name: 'UserB' });
  const { server, base } = await startServer();

  // A creates a conversation.
  const put = await fetch(`${base}/v1/conversations/c1`, {
    method: 'PUT',
    headers: { ...bearer(a.key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'A chat', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(put.status, 200);

  // A sees it; B does not.
  const aList = await (await fetch(`${base}/v1/conversations`, { headers: bearer(a.key) })).json();
  assert.equal(aList.conversations.length, 1);
  assert.equal(aList.conversations[0].id, 'c1');

  const bList = await (await fetch(`${base}/v1/conversations`, { headers: bearer(b.key) })).json();
  assert.equal(bList.conversations.length, 0);

  // B cannot read A's conversation by id.
  const bGet = await fetch(`${base}/v1/conversations/c1`, { headers: bearer(b.key) });
  assert.equal(bGet.status, 404);

  // A can delete their own.
  const del = await fetch(`${base}/v1/conversations/c1`, { method: 'DELETE', headers: bearer(a.key) });
  assert.equal(del.status, 200);
  server.close();
});
