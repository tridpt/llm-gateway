import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { circuitBreaker, withRetry, withTimeout } from '../services/reliability.js';
import { latencyTracker } from '../services/latency.js';
import { mockProvider } from './mock.js';
import { openaiProvider } from './openai.js';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';

const REGISTRY = {
  mock: mockProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

/**
 * Resolve the ordered list of providers to attempt, based on PROVIDER_ORDER.
 * Unknown or unconfigured providers are skipped with a warning so a missing
 * API key never takes the whole gateway down.
 */
export function resolveProviderChain(capability) {
  const chain = [];
  for (const name of config.providerOrder) {
    const provider = REGISTRY[name];
    if (!provider) {
      logger.warn('Unknown provider in PROVIDER_ORDER, skipping', { provider: name });
      continue;
    }
    if (!provider.isConfigured()) {
      logger.warn('Provider not configured (missing API key), skipping', { provider: name });
      continue;
    }
    // Skip providers that don't support the requested capability
    // (e.g. embeddings — Anthropic has no embeddings API).
    if (capability && typeof provider[capability] !== 'function') {
      continue;
    }
    chain.push(provider);
  }
  return chain;
}

/**
 * Run an async operation against the provider chain with full reliability:
 * circuit breaker (skip failing providers), per-attempt timeout, and retry
 * with exponential backoff before falling back to the next provider.
 *
 * @param {(provider, signal) => Promise<T>} run - operation given a provider + abort signal
 * @returns {Promise<{ result: T, provider: string, usedFallback: boolean, attempts: Array }>}
 */
export async function withFallback(run, { requestId, capability } = {}) {
  const chain = resolveProviderChain(capability);
  if (chain.length === 0) {
    throw new Error(
      'No usable providers configured. Check PROVIDER_ORDER and provider API keys.'
    );
  }

  const attempts = [];
  let lastError;
  let firstAttemptedIndex = -1;

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];

    // Skip providers whose circuit is open (recent repeated failures).
    if (circuitBreaker.isOpen(provider.name)) {
      attempts.push({ provider: provider.name, skipped: 'circuit_open' });
      logger.warn('Skipping provider, circuit is open', {
        requestId,
        provider: provider.name,
      });
      continue;
    }

    if (firstAttemptedIndex === -1) firstAttemptedIndex = i;

    try {
      const result = await withRetry(
        () =>
          withTimeout(config.reliability.timeoutMs, (signal) =>
            run(provider, signal)
          ),
        { requestId, provider: provider.name }
      );

      circuitBreaker.recordSuccess(provider.name);
      return {
        result,
        provider: provider.name,
        usedFallback: i > firstAttemptedIndex,
        attempts,
      };
    } catch (err) {
      lastError = err;
      circuitBreaker.recordFailure(provider.name);
      attempts.push({ provider: provider.name, error: err.message });
      logger.warn('Provider failed after retries, trying next in chain', {
        requestId,
        provider: provider.name,
        error: err.message,
      });
    }
  }

  const error = new Error(
    `All providers failed. Last error: ${lastError?.message || 'unknown'}`
  );
  error.attempts = attempts;
  throw error;
}

export { REGISTRY };

/**
 * Execute an operation across an ordered list of route targets, with the full
 * reliability stack per attempt (circuit breaker, timeout, retry+backoff) and
 * fallback to the next target. Records latency on success for latency routing.
 *
 * @param {Array<{provider, model, tier}>} targets - ordered fallback chain
 * @param {(provider, model, signal) => Promise<T>} run
 * @returns {Promise<{ result, provider, model, tier, usedFallback, attempts }>}
 */
export async function executeAcrossTargets(targets, run, { requestId } = {}) {
  if (!targets || targets.length === 0) {
    throw new Error('No route targets available for this request.');
  }

  const attempts = [];
  let lastError;
  let firstAttempted = -1;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const provider = REGISTRY[target.provider];
    if (!provider) {
      attempts.push({ ...target, skipped: 'unknown_provider' });
      continue;
    }

    if (circuitBreaker.isOpen(target.provider)) {
      attempts.push({ ...target, skipped: 'circuit_open' });
      logger.warn('Skipping target, circuit is open', { requestId, ...target });
      continue;
    }

    if (firstAttempted === -1) firstAttempted = i;

    const startedAt = Date.now();
    try {
      const result = await withRetry(
        () =>
          withTimeout(config.reliability.timeoutMs, (signal) =>
            run(provider, target.model, signal)
          ),
        { requestId, provider: target.provider }
      );

      latencyTracker.record(target.provider, target.model, Date.now() - startedAt);
      circuitBreaker.recordSuccess(target.provider);
      return {
        result,
        provider: target.provider,
        model: target.model,
        tier: target.tier,
        usedFallback: i > firstAttempted,
        attempts,
      };
    } catch (err) {
      lastError = err;
      circuitBreaker.recordFailure(target.provider);
      attempts.push({ ...target, error: err.message });
      logger.warn('Target failed after retries, trying next', {
        requestId,
        ...target,
        error: err.message,
      });
    }
  }

  const error = new Error(
    `All route targets failed. Last error: ${lastError?.message || 'unknown'}`
  );
  error.attempts = attempts;
  throw error;
}

/**
 * Open a streaming response across route targets. Falls back to the next
 * target only if a target fails before emitting its first chunk (you cannot
 * cleanly switch providers mid-stream). Applies per-attempt timeout + circuit
 * breaker and records connection latency.
 *
 * @param {Array<{provider, model, tier}>} targets
 * @param {(provider, model, signal) => AsyncGenerator} run
 * @returns {Promise<{iterator, firstChunk, provider, model, tier, usedFallback}>}
 */
export async function openStreamAcrossTargets(targets, run, { requestId } = {}) {
  let attemptedCount = 0;
  let lastError;

  for (const target of targets) {
    const provider = REGISTRY[target.provider];
    if (!provider) continue;

    if (circuitBreaker.isOpen(target.provider)) {
      logger.warn('Skipping streaming target, circuit is open', { requestId, ...target });
      continue;
    }

    const connectStart = Date.now();
    try {
      const opened = await withTimeout(config.reliability.timeoutMs, async (signal) => {
        const gen = run(provider, target.model, signal);
        const first = await gen.next();
        return { gen, first };
      });

      latencyTracker.record(target.provider, target.model, Date.now() - connectStart);
      circuitBreaker.recordSuccess(target.provider);
      return {
        iterator: opened.gen,
        firstChunk: opened.first,
        provider: target.provider,
        model: target.model,
        tier: target.tier,
        usedFallback: attemptedCount > 0,
      };
    } catch (err) {
      lastError = err;
      attemptedCount += 1;
      circuitBreaker.recordFailure(target.provider);
      logger.warn('Streaming target failed before first chunk, trying next', {
        requestId,
        ...target,
        error: err.message,
      });
    }
  }

  throw lastError || new Error('No streaming target available (all circuits open).');
}
