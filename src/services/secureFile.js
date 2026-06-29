import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Transparent encryption-at-rest for the gateway's small JSON stores
 * (team.json, conversations.json).
 *
 * When a secret is provided, files are written as an AES-256-GCM envelope
 * (authenticated, so tampering is detected on read). When no secret is set the
 * files stay plaintext — so existing deployments keep working, and turning on
 * encryption migrates each file transparently on its next write.
 *
 * Envelope format (single line):
 *   LLMGWENC1:<base64( iv[12] | authTag[16] | ciphertext )>
 *
 * The 32-byte AES key is derived from the secret via SHA-256, so any
 * passphrase length works. This keeps secrets out of the data files; for a
 * production system you'd manage DATA_ENCRYPTION_KEY via a secrets manager and
 * rotate it deliberately.
 */

const PREFIX = 'LLMGWENC1';
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest(); // 32 bytes
}

export function isEncrypted(text) {
  return typeof text === 'string' && text.startsWith(PREFIX + ':');
}

export function encryptString(plain, secret) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + ':' + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptString(blob, secret) {
  const raw = Buffer.from(blob.slice(PREFIX.length + 1), 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Read + parse a JSON store, decrypting if needed.
 * Returns null if the file doesn't exist. Throws if the file is encrypted but
 * no secret is available, or if decryption/authentication fails.
 */
export function loadJson(file, { secret } = {}) {
  if (!fs.existsSync(file)) return null;
  const content = fs.readFileSync(file, 'utf8').trim();
  if (!content) return null;
  if (isEncrypted(content)) {
    if (!secret) throw new Error('File is encrypted but no DATA_ENCRYPTION_KEY is set.');
    return JSON.parse(decryptString(content, secret));
  }
  return JSON.parse(content); // plaintext (legacy or encryption disabled)
}

/** Serialize + atomically write a JSON store, encrypting when a secret is set. */
export function saveJson(file, obj, { secret, pretty = false } = {}) {
  const json = JSON.stringify(obj, null, pretty ? 2 : 0);
  const out = secret ? encryptString(json, secret) : json;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file); // atomic on the same filesystem
}
