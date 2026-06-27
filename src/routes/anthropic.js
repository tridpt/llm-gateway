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

export const anthropicRouter = express.Router();

// ── Format translation ───────────────────────────────────

/** Anthropic content can be a string or an array of typed blocks. */
function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** Anthropic Messages request → internal OpenAI-style body. */
function anthropicToInternal(body) {
  const messages = [];
  if (body.system) {
    const sys = contentToString(body.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }
  for (const m of body.messages || []) {
    messages.push({ role: m.role, content: contentToString(m.content) });
  }
  return {
    model: body.model,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
  };
}

const mapStopReason = (finish) =>
  ({ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' }[finish] || 'end_turn');

/** Internal completion result → Anthropic Messages response. */
function internalToAnthropic(id, result) {
  return {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    model: result.model,
    content: [{ type: 'text', text: result.content }],
    stop_reason: mapStopReason(result.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
    },
  };
}

// ── Route ────────────────────────────────────────────────

anthropicRouter.post('/messages', async (req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const body = req.body || {};

  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Request must include "model" and a non-empty "messages" array.' },
    });
  }

  const internal = anthropicToInternal(body);

  // Token saver (shared with the OpenAI endpoint).
  if (config.tokenSaver.enabled) {
    const { messages, stats } = applyTokenSaver(internal.messages, config.tokenSaver);
    if (stats.tokensSaved > 0 || stats.droppedMessages > 0) {
      internal.messages = messages;
      metrics.recordTokensSaved(stats.tokensSaved);
    }
  }

  const wantsStream = Boolean(body.stream);
  const cacheKey = 'anthropic:' + cache.constructor.keyFor(internal);

  // Cache lookup.
  if (config.cache.enabled) {
    const hit = cache.get(cacheKey);
    if (hit) {
      const latencyMs = Date.now() - startedAt;
      logger.info('Cache hit (anthropic)', { requestId, model: internal.model, latencyMs });
      metrics.recordRequest({
        requestId, provider: hit.provider, model: hit.model, cacheHit: true,
        inputTokens: hit.usage.inputTokens, outputTokens: hit.usage.outputTokens,
        costUsd: 0, latencyMs, stream: wantsStream, ts: new Date().toISOString(),
      });
      if (wantsStream) return replayAnthropicStream(res, requestId, hit);
      return res.json(internalToAnthropic(requestId, hit));
    }
  }

  if (resolveProviderChain().length === 0) {
    return res.status(503).json({ type: 'error', error: { type: 'overloaded_error', message: 'No usable providers configured.' } });
  }

  try {
    if (wantsStream) {
      await handleStreaming(res, { requestId, internal, body, cacheKey, startedAt, budgetKey: req.budgetKey });
    } else {
      await handleNonStreaming(res, { requestId, internal, cacheKey, startedAt, budgetKey: req.budgetKey });
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    logger.error('Anthropic request failed', { requestId, error: err.message, latencyMs });
    metrics.recordRequest({
      requestId, model: internal.model, cacheHit: false, error: true,
      latencyMs, stream: wantsStream, ts: new Date().toISOString(),
    });
    if (!res.headersSent) {
      res.status(502).json({ type: 'error', error: { type: 'api_error', message: err.message } });
    } else {
      res.end();
    }
  }
});

async function handleNonStreaming(res, { requestId, internal, cacheKey, startedAt, budgetKey }) {
  const availableProviders = resolveProviderChain().map((p) => p.name);
  const targets = router.resolveTargets(internal.model, availableProviders);

  const { result, provider, model, tier, usedFallback } = await executeAcrossTargets(
    targets,
    (p, m, signal) => p.chatCompletion({ body: internal, model: m, signal }),
    { requestId }
  );

  const costUsd = computeCost(result.model, result.usage.inputTokens, result.usage.outputTokens);
  const latencyMs = Date.now() - startedAt;

  if (budgetKey) budgetManager.addCost(budgetKey, costUsd);
  if (config.cache.enabled) cache.set(cacheKey, { ...result, provider });

  logger.info('Anthropic completion served', { requestId, provider, model, tier, usedFallback, costUsd, latencyMs });
  metrics.recordRequest({
    requestId, provider, model: result.model, tier, cacheHit: false, usedFallback,
    inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
    costUsd, latencyMs, stream: false, ts: new Date().toISOString(),
  });

  res.json(internalToAnthropic(requestId, result));
}

// ── Anthropic SSE helpers ────────────────────────────────

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function emit(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function startEvents(res, requestId, model, inputTokens) {
  emit(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${requestId}`, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
  emit(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
}

function stopEvents(res, finishReason, outputTokens) {
  emit(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  emit(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  emit(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function handleStreaming(res, { requestId, internal, cacheKey, startedAt, budgetKey }) {
  const availableProviders = resolveProviderChain().map((p) => p.name);
  const targets = router.resolveTargets(internal.model, availableProviders);

  const { iterator, firstChunk, provider, model, tier, usedFallback } = await openStreamAcrossTargets(
    targets,
    (p, m, signal) => p.streamCompletion({ body: internal, model: m, signal }),
    { requestId }
  );

  sseHeaders(res);
  startEvents(res, requestId, model, estimateInput(internal));

  let fullText = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = 'stop';

  let chunk = firstChunk;
  while (chunk && !chunk.done) {
    const value = chunk.value;
    if (value.type === 'delta') {
      fullText += value.text;
      emit(res, 'content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: value.text },
      });
    } else if (value.type === 'done') {
      usage = value.usage;
      finishReason = value.finishReason;
    }
    chunk = await iterator.next();
  }

  stopEvents(res, finishReason, usage.outputTokens);

  const costUsd = computeCost(model, usage.inputTokens, usage.outputTokens);
  if (budgetKey) budgetManager.addCost(budgetKey, costUsd);
  if (config.cache.enabled && fullText) {
    cache.set(cacheKey, { model, content: fullText, finishReason, usage, provider });
  }

  metrics.recordRequest({
    requestId, provider, model, tier, cacheHit: false, usedFallback,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    costUsd, latencyMs: Date.now() - startedAt, stream: true, ts: new Date().toISOString(),
  });
}

function replayAnthropicStream(res, requestId, hit) {
  sseHeaders(res);
  startEvents(res, requestId, hit.model, hit.usage.inputTokens);
  for (const word of hit.content.split(' ')) {
    emit(res, 'content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: word + ' ' },
    });
  }
  stopEvents(res, hit.finishReason || 'stop', hit.usage.outputTokens);
}

function estimateInput(internal) {
  // Cheap estimate for the message_start event (real usage arrives at the end).
  return internal.messages.reduce(
    (s, m) => s + Math.ceil(String(m.content).length / 4) + 4,
    0
  );
}
