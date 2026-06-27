import express from 'express';
import { metrics } from '../services/metrics.js';
import { cache } from '../services/cache.js';
import { config } from '../config.js';
import { resolveProviderChain } from '../providers/index.js';
import { PRICING } from '../services/cost.js';
import { circuitBreaker } from '../services/reliability.js';

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
  });
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
