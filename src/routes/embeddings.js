import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { cache } from '../services/cache.js';
import { metrics } from '../services/metrics.js';
import { logger } from '../services/logger.js';
import { computeCost } from '../services/cost.js';
import { resolveProviderChain, executeAcrossTargets } from '../providers/index.js';
import { router } from '../routing/router.js';
import { budgetManager } from '../services/budget.js';

export const embeddingsRouter = express.Router();

function cacheKeyFor(model, input) {
  return (
    'emb:' +
    crypto.createHash('sha256').update(JSON.stringify({ model, input })).digest('hex')
  );
}

function buildResponse({ model, vectors, usage, cached }) {
  return {
    object: 'list',
    model,
    gateway: { cached: Boolean(cached) },
    data: vectors.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding,
    })),
    usage: {
      prompt_tokens: usage.inputTokens,
      total_tokens: usage.inputTokens,
    },
  };
}

embeddingsRouter.post('/embeddings', async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const body = req.body || {};
  const { model, input } = body;

  // ── Validation ───────────────────────────────────────
  const validInput =
    typeof input === 'string' ||
    (Array.isArray(input) && input.length > 0 && input.every((s) => typeof s === 'string'));

  if (!model || !validInput) {
    return res.status(400).json({
      error: {
        message: 'Request must include "model" and "input" (a string or array of strings).',
        type: 'invalid_request_error',
      },
    });
  }

  const cacheKey = cacheKeyFor(model, input);

  // ── Cache lookup ─────────────────────────────────────
  if (config.cache.enabled) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const latencyMs = Date.now() - startedAt;
      logger.info('Embeddings cache hit', { requestId, model, latencyMs });
      metrics.recordRequest({
        requestId,
        model: hit.model,
        provider: hit.provider,
        cacheHit: true,
        inputTokens: hit.usage.inputTokens,
        outputTokens: 0,
        costUsd: 0,
        latencyMs,
        stream: false,
        ts: new Date().toISOString(),
      });
      return res.json(
        buildResponse({ model: hit.model, vectors: hit.vectors, usage: hit.usage, cached: true })
      );
    }
  }

  if (resolveProviderChain('embeddings').length === 0) {
    return res.status(503).json({
      error: {
        message: 'No provider in PROVIDER_ORDER supports embeddings.',
        type: 'service_unavailable',
      },
    });
  }

  try {
    const availableProviders = resolveProviderChain('embeddings').map((p) => p.name);
    const targets = router.resolveTargets(model, availableProviders);

    const { result, provider, tier, usedFallback } = await executeAcrossTargets(
      targets,
      (p, m, signal) => p.embeddings({ input, model: m, signal }),
      { requestId }
    );

    const costUsd = computeCost(result.model, result.usage.inputTokens, 0);
    const latencyMs = Date.now() - startedAt;

    if (req.budgetKey) budgetManager.addCost(req.budgetKey, costUsd);

    if (config.cache.enabled) {
      cache.set(cacheKey, { ...result, provider });
    }

    logger.info('Embeddings served', {
      requestId,
      provider,
      tier,
      usedFallback,
      model: result.model,
      count: result.vectors.length,
      inputTokens: result.usage.inputTokens,
      costUsd,
      latencyMs,
    });

    metrics.recordRequest({
      requestId,
      provider,
      model: result.model,
      tier,
      cacheHit: false,
      usedFallback,
      inputTokens: result.usage.inputTokens,
      outputTokens: 0,
      costUsd,
      latencyMs,
      stream: false,
      ts: new Date().toISOString(),
    });

    res.json(
      buildResponse({ model: result.model, vectors: result.vectors, usage: result.usage })
    );
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    logger.error('Embeddings request failed', { requestId, error: err.message, latencyMs });
    metrics.recordRequest({
      requestId,
      model,
      cacheHit: false,
      error: true,
      latencyMs,
      stream: false,
      ts: new Date().toISOString(),
    });
    res.status(502).json({
      error: { message: err.message, type: 'upstream_error', attempts: err.attempts },
    });
  }
});
