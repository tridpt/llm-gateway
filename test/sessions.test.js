import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, verifySessionToken } from '../src/services/sessions.js';

test('a freshly minted token verifies and carries its key', () => {
  const { token, expiresAt } = createSessionToken('demo-key-123');
  assert.match(token, /^gw-session-v1\./);
  assert.ok(Date.parse(expiresAt) > Date.now());

  const payload = verifySessionToken(token);
  assert.ok(payload);
  assert.equal(payload.key, 'demo-key-123');
  assert.ok(payload.exp > payload.iat);
});

test('verify rejects a tampered payload', () => {
  const { token } = createSessionToken('demo-key-123');
  const [prefix, , sig] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ key: 'attacker', exp: 9_999_999_999 })).toString(
    'base64url',
  );
  const forged = `${prefix}.${forgedPayload}.${sig}`;
  assert.equal(verifySessionToken(forged), null);
});

test('verify rejects malformed tokens', () => {
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken(null), null);
  assert.equal(verifySessionToken('not-a-token'), null);
  assert.equal(verifySessionToken('gw-session-v1.onlytwo'), null);
});

test('verify rejects an expired token', () => {
  const { token } = createSessionToken('demo-key-123', -10);
  assert.equal(verifySessionToken(token), null);
});

test('expiresAt reflects the requested TTL', () => {
  const ttl = 3600;
  const before = Math.floor(Date.now() / 1000);
  const { expiresAt } = createSessionToken('demo-key-123', ttl);
  const exp = Math.floor(Date.parse(expiresAt) / 1000);
  assert.ok(exp >= before + ttl - 2 && exp <= before + ttl + 2);
});
