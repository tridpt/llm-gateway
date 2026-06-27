/**
 * Cost & token accounting.
 *
 * Prices are USD per 1,000,000 tokens (input / output).
 * These are approximate public list prices and are easy to update.
 * If a model is unknown, we fall back to a conservative default so the
 * gateway never silently reports "$0".
 */
const PRICING = {
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },

  // Anthropic
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },

  // Google Gemini (paid-tier list prices; the free tier costs $0)
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-flash-lite': { input: 0.1, output: 0.4 },

  // Mock provider (free)
  'mock-gpt': { input: 0, output: 0 },

  // Embedding models (priced on input tokens only; output = 0)
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-ada-002': { input: 0.1, output: 0 },
  'gemini-embedding-001': { input: 0.15, output: 0 },
  'text-embedding-004': { input: 0, output: 0 },
  'mock-embed': { input: 0, output: 0 },
};

const DEFAULT_PRICING = { input: 1, output: 3 };

function priceFor(model = '') {
  if (PRICING[model]) return PRICING[model];
  // Match on prefix so "gpt-4o-2024-08-06" still maps to "gpt-4o".
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  return key ? PRICING[key] : DEFAULT_PRICING;
}

/**
 * Rough token estimate when a provider does not return usage.
 * ~4 characters per token is the common heuristic for English text.
 */
export function estimateTokens(text = '') {
  return Math.ceil(String(text).length / 4);
}

/**
 * Estimate prompt tokens from an OpenAI-style messages array.
 */
export function estimateMessagesTokens(messages = []) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    total += 4; // per-message overhead
  }
  return total;
}

/**
 * Compute cost in USD given token counts and a model name.
 */
export function computeCost(model, inputTokens, outputTokens) {
  const p = priceFor(model);
  const cost =
    (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  // Round to 6 decimals to avoid floating noise.
  return Math.round(cost * 1e6) / 1e6;
}

export { PRICING };
