import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamStore } from '../src/services/team.js';

function tmpFile() {
  return path.join(os.tmpdir(), `llmgw-team-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}
function freshStore() {
  const file = tmpFile();
  fs.rmSync(file, { force: true });
  return { store: new TeamStore({ file }), file };
}

test('create generates a unique sk-team key and normalizes fields', () => {
  const { store, file } = freshStore();
  const m = store.create({ name: 'Alice', dailyRequests: 10, dailyCostUsd: 0.5 });
  assert.match(m.key, /^sk-team-[0-9a-f]+$/);
  assert.equal(m.name, 'Alice');
  assert.equal(m.dailyRequests, 10);
  assert.equal(m.admin, false);
  assert.equal(m.disabled, false);
  assert.equal(m.username, 'alice');
  assert.ok(m.password);
  assert.ok(m.createdAt);
  assert.equal('passwordHash' in m, false);
  fs.rmSync(file, { force: true });
});

test('username/password login verifies without leaking password hashes', () => {
  const { store, file } = freshStore();
  const m = store.create({ name: 'Alice Smith', username: 'alice', password: 'secret-123' });

  const loggedIn = store.verifyLogin('Alice', 'secret-123');
  assert.equal(loggedIn.key, m.key);
  assert.equal(loggedIn.username, 'alice');
  assert.equal(store.verifyLogin('alice', 'wrong'), null);
  assert.equal('passwordHash' in store.get(m.key), false);
  assert.equal('passwordHash' in store.list()[0], false);

  fs.rmSync(file, { force: true });
});

test('resetPassword rotates member login password', () => {
  const { store, file } = freshStore();
  const m = store.create({ name: 'Reset Me', password: 'old-password' });
  const rotated = store.resetPassword(m.key);

  assert.ok(rotated.password);
  assert.notEqual(rotated.password, 'old-password');
  assert.equal(store.verifyLogin(m.username, 'old-password'), null);
  assert.equal(store.verifyLogin(m.username, rotated.password).key, m.key);

  fs.rmSync(file, { force: true });
});

test('isActive / isAdmin reflect flags and disabled state', () => {
  const { store, file } = freshStore();
  const member = store.create({ name: 'Bob' });
  const admin = store.create({ name: 'Carol', admin: true });

  assert.equal(store.isActive(member.key), true);
  assert.equal(store.isAdmin(member.key), false);
  assert.equal(store.isAdmin(admin.key), true);

  store.update(admin.key, { disabled: true });
  assert.equal(store.isActive(admin.key), false);
  assert.equal(store.isAdmin(admin.key), false); // disabled admins lose admin
  fs.rmSync(file, { force: true });
});

test('getLimits returns per-member limits, or null for unknown keys', () => {
  const { store, file } = freshStore();
  const m = store.create({ name: 'Dee', dailyRequests: 3, dailyCostUsd: null });
  assert.deepEqual(store.getLimits(m.key), { dailyRequests: 3, dailyCostUsd: null });
  assert.equal(store.getLimits('not-a-member'), null);
  fs.rmSync(file, { force: true });
});

test('update patches only known fields', () => {
  const { store, file } = freshStore();
  const m = store.create({ name: 'Eve', dailyRequests: 1 });
  const updated = store.update(m.key, { name: 'Eve2', dailyRequests: 99, bogus: 'x' });
  assert.equal(updated.name, 'Eve2');
  assert.equal(updated.dailyRequests, 99);
  assert.equal('bogus' in updated, false);
  assert.equal(store.update('missing', { name: 'x' }), null);
  fs.rmSync(file, { force: true });
});

test('remove deletes a member', () => {
  const { store, file } = freshStore();
  const m = store.create({ name: 'Frank' });
  assert.equal(store.remove(m.key), true);
  assert.equal(store.has(m.key), false);
  assert.equal(store.remove(m.key), false);
  fs.rmSync(file, { force: true });
});

test('members persist across store instances (same file)', () => {
  const file = tmpFile();
  fs.rmSync(file, { force: true });
  const s1 = new TeamStore({ file });
  const m = s1.create({ name: 'Grace', admin: true });

  const s2 = new TeamStore({ file }); // reload from disk
  const reloaded = s2.get(m.key);
  assert.ok(reloaded);
  assert.equal(reloaded.name, 'Grace');
  assert.equal(reloaded.admin, true);
  fs.rmSync(file, { force: true });
});
