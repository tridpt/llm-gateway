import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { circuitBreaker, withRetry, withTimeout } from '../services/reliability.js';
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
