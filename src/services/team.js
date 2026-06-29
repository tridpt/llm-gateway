import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from './logger.js';
import { loadJson, saveJson } from './secureFile.js';

/**
 * Team / member store.
 *
 * Each member is a person who can use the team chat. Their gateway key is both
 * their credential and their budget bucket, so per-member daily limits are
 * enforced by the existing BudgetManager. Members are persisted to team.json
 * at the project root (atomic write) so they survive restarts.
 *
 *   member = { key, name, dailyRequests, dailyCostUsd, admin, disabled, createdAt }
 *
 * A null limit means unlimited. This store is separate from budgets.json on
 * purpose: budgets.json stays a static, hand-edited file; team.json is managed
 * at runtime from the admin UI.
 */
export class TeamStore {
  constructor({ file, secret } = {}) {
    this.file = file || process.env.TEAM_FILE || path.join(config.rootDir, 'team.json');
    this.secret = secret !== undefined ? secret : config.encryption.key;
    this.members = new Map(); // key -> member
    this._load();
  }

  _load() {
    try {
      const parsed = loadJson(this.file, { secret: this.secret });
      if (!parsed) return;
      for (const m of parsed.members || []) {
        if (m && m.key) this.members.set(m.key, this._normalize(m));
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
      name: m.name || 'Member',
      dailyRequests: m.dailyRequests ?? null,
      dailyCostUsd: m.dailyCostUsd ?? null,
      admin: Boolean(m.admin),
      disabled: Boolean(m.disabled),
      createdAt: m.createdAt || new Date().toISOString(),
    };
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
    return this.members.get(key) || null;
  }

  /** Per-member limits for the BudgetManager, or null if not a member. */
  getLimits(key) {
    const m = this.members.get(key);
    if (!m) return null;
    return { dailyRequests: m.dailyRequests, dailyCostUsd: m.dailyCostUsd };
  }

  /** Public listing — safe to show admins (keys are identities they hand out). */
  list() {
    return [...this.members.values()].sort((a, b) =>
      (a.createdAt || '').localeCompare(b.createdAt || '')
    );
  }

  create({ name, dailyRequests = null, dailyCostUsd = null, admin = false } = {}) {
    const key = 'sk-team-' + crypto.randomBytes(18).toString('hex');
    const member = this._normalize({ key, name, dailyRequests, dailyCostUsd, admin });
    this.members.set(key, member);
    this._save();
    logger.info('Team member created', { name: member.name, admin: member.admin });
    return member;
  }

  update(key, patch = {}) {
    const m = this.members.get(key);
    if (!m) return null;
    const allowed = ['name', 'dailyRequests', 'dailyCostUsd', 'admin', 'disabled'];
    for (const field of allowed) {
      if (field in patch) m[field] = patch[field];
    }
    this.members.set(key, this._normalize({ ...m, key, createdAt: m.createdAt }));
    this._save();
    return this.members.get(key);
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
