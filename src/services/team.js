import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from './logger.js';
import { loadJson, saveJson } from './secureFile.js';

const PASSWORD_ITERATIONS = 210000;
const PASSWORD_KEYLEN = 32;
const PASSWORD_DIGEST = 'sha256';

export function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/[._-]{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 50);
}

function usernameFromName(name) {
  return normalizeUsername(name) || 'member';
}

export function generatePassword() {
  return crypto.randomBytes(9).toString('base64url');
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
  const hash = crypto
    .pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, PASSWORD_DIGEST)
    .toString('base64url');
  return `pbkdf2:${PASSWORD_DIGEST}:${PASSWORD_ITERATIONS}:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [kind, digest, iterations, salt, expected] = String(stored).split(':');
  if (kind !== 'pbkdf2' || !digest || !iterations || !salt || !expected) return false;

  const expectedBytes = Buffer.from(expected, 'base64url');
  const actualBytes = crypto.pbkdf2Sync(
    String(password),
    salt,
    Number(iterations),
    expectedBytes.length,
    digest
  );
  return (
    actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes)
  );
}

/**
 * Team / member store.
 *
 * Each member is a person who can use the team chat. Their gateway key is both
 * their stable identity and their budget bucket. Username/password login now
 * lets the UI hide that key from everyday users.
 *
 *   member = {
 *     key, username, passwordHash, name,
 *     dailyRequests, dailyCostUsd, admin, disabled, createdAt
 *   }
 *
 * A null limit means unlimited. This store is separate from budgets.json on
 * purpose: budgets.json stays a static, hand-edited file; team.json is managed
 * at runtime from the admin UI.
 */
export class TeamStore {
  constructor({ file, secret } = {}) {
    this.file = file || process.env.TEAM_FILE || path.join(config.rootDir, 'team.json');
    this.secret = secret !== undefined ? secret : config.encryption.key;
    this.members = new Map(); // key -> internal member, including passwordHash
    this._load();
  }

  _load() {
    try {
      const parsed = loadJson(this.file, { secret: this.secret });
      if (!parsed) return;
      for (const m of parsed.members || []) {
        if (m && m.key) {
          const member = this._normalize(m);
          member.username = this._uniqueUsername(member.username || usernameFromName(member.name), member.key);
          this.members.set(member.key, member);
        }
      }
      logger.info('Loaded team.json', { members: this.members.size, encrypted: Boolean(this.secret) });
    } catch (err) {
      logger.error('Failed to load team.json, starting empty', { error: err.message });
    }
  }

  _save() {
    const data = { members: [...this.members.values()] };
    saveJson(this.file, data, { secret: this.secret, pretty: !this.secret });
  }

  _normalize(m) {
    return {
      key: m.key,
      username: m.username ? normalizeUsername(m.username) : null,
      passwordHash: m.passwordHash || null,
      name: m.name || 'Member',
      dailyRequests: m.dailyRequests ?? null,
      dailyCostUsd: m.dailyCostUsd ?? null,
      admin: Boolean(m.admin),
      disabled: Boolean(m.disabled),
      createdAt: m.createdAt || new Date().toISOString(),
    };
  }

  _public(m) {
    if (!m) return null;
    const { passwordHash, ...safe } = m;
    return safe;
  }

  _uniqueUsername(base, currentKey = null) {
    const root = normalizeUsername(base) || 'member';
    let candidate = root;
    let i = 2;
    while ([...this.members.values()].some((m) => m.key !== currentKey && m.username === candidate)) {
      candidate = `${root}${i++}`;
    }
    return candidate;
  }

  has(key) {
    return this.members.has(key);
  }

  /** A key may authenticate if it is a known, non-disabled member. */
  isActive(key) {
    const m = this.members.get(key);
    return Boolean(m && !m.disabled);
  }

  isAdmin(key) {
    const m = this.members.get(key);
    return Boolean(m && m.admin && !m.disabled);
  }

  get(key) {
    return this._public(this.members.get(key));
  }

  /** Per-member limits for the BudgetManager, or null if not a member. */
  getLimits(key) {
    const m = this.members.get(key);
    if (!m) return null;
    return { dailyRequests: m.dailyRequests, dailyCostUsd: m.dailyCostUsd };
  }

  /** Public listing: safe for admin APIs; password hashes never leave here. */
  list() {
    return [...this.members.values()]
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      .map((m) => this._public(m));
  }

  create({ name, username, password, dailyRequests = null, dailyCostUsd = null, admin = false } = {}) {
    const key = 'sk-team-' + crypto.randomBytes(18).toString('hex');
    const plainPassword = password || generatePassword();
    const member = this._normalize({
      key,
      name,
      username: this._uniqueUsername(username || usernameFromName(name)),
      passwordHash: hashPassword(plainPassword),
      dailyRequests,
      dailyCostUsd,
      admin,
    });

    this.members.set(key, member);
    this._save();
    logger.info('Team member created', { name: member.name, username: member.username, admin: member.admin });
    return { ...this._public(member), password: plainPassword };
  }

  update(key, patch = {}) {
    const m = this.members.get(key);
    if (!m) return null;

    const allowed = ['name', 'dailyRequests', 'dailyCostUsd', 'admin', 'disabled'];
    for (const field of allowed) {
      if (field in patch) m[field] = patch[field];
    }
    if ('username' in patch) m.username = this._uniqueUsername(patch.username || usernameFromName(m.name), key);
    if ('password' in patch && patch.password) m.passwordHash = hashPassword(patch.password);

    this.members.set(key, this._normalize({ ...m, key, createdAt: m.createdAt }));
    this._save();
    return this._public(this.members.get(key));
  }

  resetPassword(key) {
    const m = this.members.get(key);
    if (!m) return null;
    const password = generatePassword();
    if (!m.username) m.username = this._uniqueUsername(usernameFromName(m.name), key);
    m.passwordHash = hashPassword(password);
    this.members.set(key, this._normalize({ ...m, key, createdAt: m.createdAt }));
    this._save();
    return { ...this._public(this.members.get(key)), password };
  }

  verifyLogin(username, password) {
    const normalized = normalizeUsername(username);
    if (!normalized || !password) return null;
    const m = [...this.members.values()].find((member) => member.username === normalized);
    if (!m || m.disabled || !verifyPassword(password, m.passwordHash)) return null;
    return this._public(m);
  }

  remove(key) {
    const existed = this.members.delete(key);
    if (existed) this._save();
    return existed;
  }

  snapshot() {
    return { count: this.members.size, members: this.list() };
  }
}

export const team = new TeamStore();
