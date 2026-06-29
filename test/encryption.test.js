import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  encryptString, decryptString, isEncrypted, loadJson, saveJson,
} from '../src/services/secureFile.js';
import { TeamStore } from '../src/services/team.js';
import { ConversationStore } from '../src/services/conversations.js';

const SECRET = 'correct horse battery staple';
function tmp(name) {
  return path.join(os.tmpdir(), `llmgw-enc-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('encrypt/decrypt round-trips and produces an opaque envelope', () => {
  const blob = encryptString('hello secret', SECRET);
  assert.equal(isEncrypted(blob), true);
  assert.equal(blob.includes('hello'), false); // plaintext not visible
  assert.equal(decryptString(blob, SECRET), 'hello secret');
});

test('decryption fails with the wrong secret (authenticated)', () => {
  const blob = encryptString('top secret', SECRET);
  assert.throws(() => decryptString(blob, 'wrong key'));
});

test('decryption fails if the ciphertext is tampered with', () => {
  const blob = encryptString('integrity', SECRET);
  // Flip a character in the base64 body.
  const body = blob.slice(blob.indexOf(':') + 1);
  const tampered = blob.slice(0, blob.indexOf(':') + 1) + (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
  assert.throws(() => decryptString(tampered, SECRET));
});

test('saveJson encrypts when a secret is set; loadJson reads it back', () => {
  const file = tmp('savejson');
  saveJson(file, { hello: 'world' }, { secret: SECRET });
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(isEncrypted(raw), true);
  assert.equal(raw.includes('world'), false);
  assert.deepEqual(loadJson(file, { secret: SECRET }), { hello: 'world' });
  fs.rmSync(file, { force: true });
});

test('saveJson stays plaintext when no secret is set', () => {
  const file = tmp('plain');
  saveJson(file, { hello: 'world' });
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(isEncrypted(raw), false);
  assert.ok(raw.includes('world'));
  fs.rmSync(file, { force: true });
});

test('loadJson throws on an encrypted file when no secret is provided', () => {
  const file = tmp('nosecret');
  saveJson(file, { a: 1 }, { secret: SECRET });
  assert.throws(() => loadJson(file, {}), /encrypted/i);
  fs.rmSync(file, { force: true });
});

test('TeamStore with a secret never writes member keys/names in plaintext', () => {
  const file = tmp('team');
  const store = new TeamStore({ file, secret: SECRET });
  const m = store.create({ name: 'SecretName', dailyRequests: 5 });

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(isEncrypted(raw), true);
  assert.equal(raw.includes('SecretName'), false);
  assert.equal(raw.includes(m.key), false); // the API key (credential) is not on disk in clear

  // A new store with the same secret can read it back.
  const reopened = new TeamStore({ file, secret: SECRET });
  assert.equal(reopened.get(m.key)?.name, 'SecretName');
  fs.rmSync(file, { force: true });
});

test('ConversationStore with a secret encrypts history on disk', () => {
  const file = tmp('conv');
  const store = new ConversationStore({ file, secret: SECRET });
  store.upsert('owner', { id: 'c1', title: 'Lunch plans', messages: [{ role: 'user', content: 'pizza?' }] });

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(isEncrypted(raw), true);
  assert.equal(raw.includes('pizza'), false);

  const reopened = new ConversationStore({ file, secret: SECRET });
  assert.equal(reopened.get('owner', 'c1')?.messages[0].content, 'pizza?');
  fs.rmSync(file, { force: true });
});

test('a plaintext store migrates to encrypted on next write', () => {
  const file = tmp('migrate');
  // Start plaintext.
  const plain = new TeamStore({ file });
  const m = plain.create({ name: 'Legacy' });
  assert.equal(isEncrypted(fs.readFileSync(file, 'utf8')), false);

  // Reopen WITH a secret: it reads the plaintext, then encrypts on the next save.
  const upgraded = new TeamStore({ file, secret: SECRET });
  assert.equal(upgraded.get(m.key)?.name, 'Legacy'); // read legacy plaintext fine
  upgraded.update(m.key, { name: 'Migrated' });       // triggers a save
  assert.equal(isEncrypted(fs.readFileSync(file, 'utf8')), true);
  fs.rmSync(file, { force: true });
});
