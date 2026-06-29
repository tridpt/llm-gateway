import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';
import { loadJson, saveJson } from './secureFile.js';

/**
 * Server-side conversation store (so a member's chats sync across devices).
 *
 * Conversations are owned by the caller's gateway key and grouped by owner:
 *
 *   { [ownerKey]: { [convId]: { id, title, system, model, messages, updated, created } } }
 *
 * Persisted to conversations.json at the project root with an atomic write.
 * This keeps the chat history on the gateway, not just in one browser — the
 * trade-off is that history is stored server-side in plaintext, so treat the
 * file like any other sensitive store (it is git-ignored).
 */
export class ConversationStore {
  constructor({ file, secret, maxPerOwner = 200 } = {}) {
    this.file = file || process.env.CONVERSATIONS_FILE || path.join(config.rootDir, 'conversations.json');
    this.secret = secret !== undefined ? secret : config.encryption.key;
    this.maxPerOwner = maxPerOwner;
    this.data = {}; // ownerKey -> { convId -> conv }
    this._load();
  }

  _load() {
    try {
      this.data = loadJson(this.file, { secret: this.secret }) || {};
      logger.info('Loaded conversations.json', {
        owners: Object.keys(this.data).length,
        encrypted: Boolean(this.secret),
      });
    } catch (err) {
      logger.error('Failed to load conversations.json, starting empty', { error: err.message });
      this.data = {};
    }
  }

  _save() {
    saveJson(this.file, this.data, { secret: this.secret });
  }

  _owner(owner) {
    if (!this.data[owner]) this.data[owner] = {};
    return this.data[owner];
  }

  /** List an owner's conversations, newest first. */
  list(owner) {
    const bucket = this.data[owner] || {};
    return Object.values(bucket).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  get(owner, id) {
    return (this.data[owner] || {})[id] || null;
  }

  /** Insert or replace a conversation. Returns the stored record. */
  upsert(owner, conv) {
    if (!conv || !conv.id) throw new Error('conversation must have an id');
    const bucket = this._owner(owner);
    const now = Date.now();
    const existing = bucket[conv.id];
    const record = {
      id: conv.id,
      title: String(conv.title || 'New chat').slice(0, 200),
      system: typeof conv.system === 'string' ? conv.system : '',
      model: conv.model || '',
      messages: Array.isArray(conv.messages)
        ? conv.messages
            .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
            .map((m) => ({ role: m.role, content: m.content }))
        : [],
      created: existing?.created || conv.created || now,
      updated: now,
    };
    bucket[conv.id] = record;
    this._enforceCap(bucket);
    this._save();
    return record;
  }

  remove(owner, id) {
    const bucket = this.data[owner];
    if (!bucket || !bucket[id]) return false;
    delete bucket[id];
    this._save();
    return true;
  }

  /** Drop the oldest conversations once an owner exceeds the cap. */
  _enforceCap(bucket) {
    const ids = Object.keys(bucket);
    if (ids.length <= this.maxPerOwner) return;
    const sorted = Object.values(bucket).sort((a, b) => (a.updated || 0) - (b.updated || 0));
    const removeCount = ids.length - this.maxPerOwner;
    for (let i = 0; i < removeCount; i++) delete bucket[sorted[i].id];
  }
}

export const conversations = new ConversationStore();
