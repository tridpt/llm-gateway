import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { cache } from '../services/cache.js';
import { metrics } from '../services/metrics.js';
import { logger } from '../services/logger.js';
import { computeCost } from '../services/cost.js';
import { resolveProviderChain, executeAcrossTargets, openStreamAcrossTargets } from '../providers/index.js';
import { router } from '../routing/router.js';
import { budgetManager } from '../services/budget.js';
import { applyTokenSaver } from '../services/tokenSaver.js';

export const chatRouter = express.Router();

function buildOpenAIResponse({ id, model, content, finishReason, usage, cached }) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    gateway: { cached: Boolean(cached) },
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason || 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
  };
}

chatRouter.post('/chat/completions', async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const body = req.body || {};

  // ── Validation ───────────────────────────────────────
  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'Request must include "model" and a non-empty "messages" array.',
        type: 'invalid_request_error',
      },
    });
  }

  // ── Token saver (trim history / whitespace to cut input tokens) ──
  if (config.tokenSaver.enabled) {
    const { messages, stats } = applyTokenSaver(body.messages, config.tokenSaver);
    if (stats.tokensSaved > 0 || stats.droppedMessages > 0) {
      body.messages = messages;
      metrics.recordTokensSaved(stats.tokensSaved);
      logger.info('Token saver applied', {
        requestId,
        droppedMessages: stats.droppedMessages,
        tokensBefore: stats.tokensBefore,
        tokensAfter: stats.tokensAfter,
      });
    }
  }

  const wantsStream = Boolean(body.stream);
  const cacheKey = cache.constructor.keyFor(body);

  // ── Cache lookup ─────────────────────────────────────
  if (config.cache.enabled) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const latencyMs = Date.now() - startedAt;
      logger.info('Cache hit', { requestId, model: body.model, latencyMs });
      metrics.recordRequest({
        requestId,
        model: hit.model,
        provider: hit.provider,
        cacheHit: true,
        inputTokens: hit.usage.inputTokens,
        outputTokens: hit.usage.outputTokens,
        costUsd: 0, // cached responses cost nothing
        latencyMs,
        stream: wantsStream,
        ts: new Date().toISOString(),
      });

      if (wantsStream) return streamFromText(res, requestId, hit, true);
      return res.json(
        buildOpenAIResponse({
          id: requestId,
          model: hit.model,
          content: hit.content,
          finishReason: hit.finishReason,
          usage: hit.usage,
          cached: true,
        })
      );
    }
  }

  // Fail fast if nothing can serve the request.
  if (resolveProviderChain().length === 0) {
    return res.status(503).json({
      error: {
        message: 'No usable providers configured.',
        type: 'service_unavailable',
      },
    });
  }

  try {
    if (wantsStream) {
      await handleStreaming(req, res, { requestId, body, cacheKey, startedAt, budgetKey: req.budgetKey });
    } else {
      await handleNonStreaming(res, { requestId, body, cacheKey, startedAt, budgetKey: req.budgetKey });
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    logger.error('Request failed', { requestId, error: err.message, latencyMs });
    metrics.recordRequest({
      requestId,
      model: body.model,
      cacheHit: false,
      error: true,
      latencyMs,
      stream: wantsStream,
      ts: new Date().toISOString(),
    });

    if (!res.headersSent) {
      res.status(502).json({
        error: { message: err.message, type: 'upstream_error', attempts: err.attempts },
      });
    } else {
      res.end();
    }
  }
});

async function handleNonStreaming(res, { requestId, body, cacheKey, startedAt, budgetKey }) {
  const availableProviders = resolveProviderChain().map((p) => p.name);
  const targets = router.resolveTargets(body.model, availableProviders);

  const { result, provider, model, tier, usedFallback } = await executeAcrossTargets(
    targets,
    (p, m, signal) => p.chatCompletion({ body, model: m, signal }),
    { requestId }
  );

  const costUsd = computeCost(result.model, result.usage.inputTokens, result.usage.outputTokens);
  const latencyMs = Date.now() - startedAt;

  if (budgetKey) budgetManager.addCost(budgetKey, costUsd);

  if (config.cache.enabled) {
    cache.set(cacheKey, { ...result, provider });
  }

  logger.info('Completion served', {
    requestId,
    provider,
    model,
    tier,
    usedFallback,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
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
    outputTokens: result.usage.outputTokens,
    costUsd,
    latencyMs,
    stream: false,
    ts: new Date().toISOString(),
  });

  res.json(
    buildOpenAIResponse({
      id: requestId,
      model: result.model,
      content: result.content,
      finishReason: result.finishReason,
      usage: result.usage,
    })
  );
}

async function handleStreaming(req, res, { requestId, body, cacheKey, startedAt, budgetKey }) {
  const availableProviders = resolveProviderChain().map((p) => p.name);
  const targets = router.resolveTargets(body.model, availableProviders);

  const { iterator, firstChunk, provider, model, tier, usedFallback } =
    await openStreamAcrossTargets(
      targets,
      (p, m, signal) => p.streamCompletion({ body, model: m, signal }),
      { requestId }
    );

  // Open the SSE stream.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendChunk = (delta, finishReason = null) => {
    const payload = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  sendChunk({ role: 'assistant' });

  let fullText = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = 'stop';

  let chunk = firstChunk;
  while (chunk && !chunk.done) {
    const value = chunk.value;
    if (value.type === 'delta') {
      fullText += value.text;
      sendChunk({ content: value.text });
    } else if (value.type === 'done') {
      usage = value.usage;
      finishReason = value.finishReason;
    }
    chunk = await iterator.next();
  }

  sendChunk({}, finishReason);
  res.write('data: [DONE]\n\n');
  res.end();

  // Post-stream accounting + cache.
  const costUsd = computeCost(model, usage.inputTokens, usage.outputTokens);
  const latencyMs = Date.now() - startedAt;

  if (budgetKey) budgetManager.addCost(budgetKey, costUsd);

  if (config.cache.enabled && fullText) {
    cache.set(cacheKey, {
      model,
      content: fullText,
      finishReason,
      usage,
      provider,
    });
  }

  logger.info('Streaming completion served', {
    requestId,
    provider,
    model,
    tier,
    usedFallback,
    outputTokens: usage.outputTokens,
    costUsd,
    latencyMs,
  });

  metrics.recordRequest({
    requestId,
    provider,
    model,
    tier,
    cacheHit: false,
    usedFallback,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
    latencyMs,
    stream: true,
    ts: new Date().toISOString(),
  });
}

/**
 * Replay a cached completion as an SSE stream (word by word) so streaming
 * clients still get a streaming-shaped response on a cache hit.
 */
function streamFromText(res, requestId, hit, cached) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (delta, finishReason = null) => {
    const payload = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: hit.model,
      gateway: { cached },
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ role: 'assistant' });
  for (const word of hit.content.split(' ')) {
    send({ content: word + ' ' });
  }
  send({}, hit.finishReason || 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}
