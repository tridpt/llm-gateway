import express from 'express';
import { metrics } from '../services/metrics.js';
import { cache } from '../services/cache.js';
import { config } from '../config.js';
import { resolveProviderChain } from '../providers/index.js';
import { PRICING } from '../services/cost.js';
import { circuitBreaker } from '../services/reliability.js';
import { latencyTracker } from '../services/latency.js';
import { router } from '../routing/router.js';
import { budgetManager } from '../services/budget.js';
import { keyPoolsSnapshot } from '../services/keypool.js';
import { team } from '../services/team.js';
import { requireAdmin } from '../middleware/auth.js';

export const adminRouter = express.Router();

adminRouter.get('/metrics', (req, res) => {
  res.json({
    ...metrics.snapshot(),
    cache: { enabled: config.cache.enabled, size: cache.size, maxEntries: config.cache.maxEntries },
    providers: {
      configured: config.providerOrder,
      active: resolveProviderChain().map((p) => p.name),
    },
    circuits: circuitBreaker.snapshot(),
    routing: router.describe(),
    latency: latencyTracker.snapshot(),
    budgets: budgetManager.snapshot(),
    keyPools: keyPoolsSnapshot(),
  });
});

adminRouter.get('/usage', (req, res) => {
  res.json({ enabled: config.budget.enabled, keys: budgetManager.snapshot() });
});

adminRouter.post('/metrics/reset', (req, res) => {
  metrics.reset();
  res.json({ ok: true, message: 'Metrics reset.' });
});

adminRouter.post('/cache/clear', (req, res) => {
  const cleared = cache.size;
  cache.clear();
  res.json({ ok: true, cleared });
});

adminRouter.get('/pricing', (req, res) => {
  res.json({ unit: 'USD per 1M tokens', models: PRICING });
});

adminRouter.get('/routes', (req, res) => {
  res.json({
    strategy: router.strategy,
    tiers: router.tiers,
    aliases: router.aliases,
    models: router.models,
  });
});

// ── Team management (admins only) ─────────────────────────────
// Provision team members, set their daily limits, disable or remove them —
// all at runtime, persisted to team.json. Each member's usage is shown
// alongside their limits so an admin sees who is burning budget.

function withUsage(member) {
  const usage = budgetManager.getUsage(member.key);
  return { ...member, usage: { requests: usage.requests, costUsd: usage.costUsd } };
}

adminRouter.get('/team', requireAdmin, (req, res) => {
  res.json({ members: team.list().map(withUsage) });
});

adminRouter.post('/team', requireAdmin, (req, res) => {
  const { name, dailyRequests, dailyCostUsd, admin } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: { message: 'name is required.', type: 'invalid_request_error' } });
  }
  const member = team.create({
    name: String(name).trim(),
    dailyRequests: numOrNull(dailyRequests),
    dailyCostUsd: numOrNull(dailyCostUsd),
    admin: Boolean(admin),
  });
  res.status(201).json({ member });
});

adminRouter.patch('/team/:key', requireAdmin, (req, res) => {
  const patch = {};
  const { name, dailyRequests, dailyCostUsd, admin, disabled } = req.body || {};
  if (name !== undefined) patch.name = String(name).trim();
  if (dailyRequests !== undefined) patch.dailyRequests = numOrNull(dailyRequests);
  if (dailyCostUsd !== undefined) patch.dailyCostUsd = numOrNull(dailyCostUsd);
  if (admin !== undefined) patch.admin = Boolean(admin);
  if (disabled !== undefined) patch.disabled = Boolean(disabled);

  const member = team.update(req.params.key, patch);
  if (!member) return res.status(404).json({ error: { message: 'Member not found.', type: 'not_found' } });
  res.json({ member: withUsage(member) });
});

adminRouter.delete('/team/:key', requireAdmin, (req, res) => {
  const removed = team.remove(req.params.key);
  if (!removed) return res.status(404).json({ error: { message: 'Member not found.', type: 'not_found' } });
  res.json({ ok: true });
});

/** Coerce to a finite number, or null (unlimited) for empty/invalid input. */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
