import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../src/services/conversations.js';

function freshStore(opts = {}) {
  const file = path.join(os.tmpdir(), `llmgw-conv-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.rmSync(file, { force: true });
  return { store: new ConversationStore({ file, ...opts }), file };
}

test('upsert stores a conversation scoped to its owner', () => {
  const { store, file } = freshStore();
  store.upsert('owner-a', { id: 'c1', title: 'Hi', messages: [{ role: 'user', content: 'hello' }] });
  const got = store.get('owner-a', 'c1');
  assert.equal(got.title, 'Hi');
  assert.equal(got.messages.length, 1);
  assert.equal(store.get('owner-b', 'c1'), null); // not visible to another owner
  fs.rmSync(file, { force: true });
});

test('upsert sanitizes messages (drops bad roles / non-string content)', () => {
  const { store, file } = freshStore();
  const rec = store.upsert('o', {
    id: 'c1',
    messages: [
      { role: 'user', content: 'ok' },
      { role: 'system', content: 'should be dropped' },
      { role: 'assistant', content: 42 },
      { role: 'assistant', content: 'fine' },
    ],
  });
  assert.deepEqual(rec.messages, [
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: 'fine' },
  ]);
  fs.rmSync(file, { force: true });
});

test('upsert requires an id', () => {
  const { store, file } = freshStore();
  assert.throws(() => store.upsert('o', { title: 'no id' }), /id/);
  fs.rmSync(file, { force: true });
});

test('upsert preserves created and bumps updated', async () => {
  const { store, file } = freshStore();
  const first = store.upsert('o', { id: 'c1', title: 'v1' });
  await new Promise((r) => setTimeout(r, 5));
  const second = store.upsert('o', { id: 'c1', title: 'v2' });
  assert.equal(second.created, first.created);
  assert.ok(second.updated >= first.updated);
  assert.equal(second.title, 'v2');
  fs.rmSync(file, { force: true });
});

test('list returns an owner\'s conversations newest first', () => {
  const { store, file } = freshStore();
  store.upsert('o', { id: 'a', title: 'A', updated: 1 });
  store.upsert('o', { id: 'b', title: 'B', updated: 2 });
  const list = store.list('o');
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'b'); // most recently updated first
  fs.rmSync(file, { force: true });
});

test('remove deletes a conversation', () => {
  const { store, file } = freshStore();
  store.upsert('o', { id: 'c1' });
  assert.equal(store.remove('o', 'c1'), true);
  assert.equal(store.get('o', 'c1'), null);
  assert.equal(store.remove('o', 'c1'), false);
  fs.rmSync(file, { force: true });
});

test('enforces a per-owner cap, dropping the oldest', () => {
  const { store, file } = freshStore({ maxPerOwner: 2 });
  store.upsert('o', { id: 'a', updated: 1 });
  store.upsert('o', { id: 'b', updated: 2 });
  store.upsert('o', { id: 'c', updated: 3 });
  const ids = store.list('o').map((c) => c.id).sort();
  assert.equal(ids.length, 2);
  assert.equal(ids.includes('a'), false); // oldest dropped
  fs.rmSync(file, { force: true });
});

test('conversations persist across store instances', () => {
  const file = path.join(os.tmpdir(), `llmgw-conv-persist-${Date.now()}.json`);
  fs.rmSync(file, { force: true });
  const s1 = new ConversationStore({ file });
  s1.upsert('o', { id: 'c1', title: 'kept' });
  const s2 = new ConversationStore({ file });
  assert.equal(s2.get('o', 'c1').title, 'kept');
  fs.rmSync(file, { force: true });
});
