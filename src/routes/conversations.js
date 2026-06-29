import express from 'express';
import { conversations } from '../services/conversations.js';

export const conversationsRouter = express.Router();

/**
 * Per-user conversation sync. Every conversation is scoped to req.clientKey,
 * so a member only ever sees and edits their own history — no cross-user
 * access, mirroring how budgets are keyed.
 */

conversationsRouter.get('/conversations', (req, res) => {
  res.json({ conversations: conversations.list(req.clientKey) });
});

conversationsRouter.get('/conversations/:id', (req, res) => {
  const conv = conversations.get(req.clientKey, req.params.id);
  if (!conv) return res.status(404).json({ error: { message: 'Not found.', type: 'not_found' } });
  res.json({ conversation: conv });
});

conversationsRouter.put('/conversations/:id', (req, res) => {
  const body = req.body || {};
  try {
    const record = conversations.upsert(req.clientKey, { ...body, id: req.params.id });
    res.json({ conversation: record });
  } catch (err) {
    res.status(400).json({ error: { message: err.message, type: 'invalid_request_error' } });
  }
});

conversationsRouter.delete('/conversations/:id', (req, res) => {
  const removed = conversations.remove(req.clientKey, req.params.id);
  if (!removed) return res.status(404).json({ error: { message: 'Not found.', type: 'not_found' } });
  res.json({ ok: true });
});
