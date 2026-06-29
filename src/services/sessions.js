import crypto from 'node:crypto';
import { config } from '../config.js';

const PREFIX = 'gw-session-v1';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function sessionSecret() {
  return (
    config.encryption.key ||
    config.gatewayApiKeys.join('|') ||
    'llm-gateway-dev-session-secret'
  );
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadB64) {
  return crypto
    .createHmac('sha256', sessionSecret())
    .update(payloadB64)
    .digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function createSessionToken(key, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    key,
    iat: now,
    exp: now + ttlSeconds,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return {
    token: `${PREFIX}.${payloadB64}.${sign(payloadB64)}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export function verifySessionToken(token) {
  const [prefix, payloadB64, sig] = String(token || '').split('.');
  if (prefix !== PREFIX || !payloadB64 || !sig) return null;
  if (!safeEqual(sign(payloadB64), sig)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.key || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
