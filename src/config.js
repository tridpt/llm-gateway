import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * Minimal .env loader (no external dependency).
 * Only sets variables that are not already present in process.env,
 * so real environment variables always win over the file.
 */
function loadEnvFile() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const bool = (v, fallback = false) => {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

const list = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  rootDir,
  port: int(process.env.PORT, 8080),

  gatewayApiKeys: list(process.env.GATEWAY_API_KEYS),

  providerOrder: list(process.env.PROVIDER_ORDER).length
    ? list(process.env.PROVIDER_ORDER)
    : ['mock'],

  openai: {
    apiKeys: list(process.env.OPENAI_API_KEY),
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  },

  anthropic: {
    apiKeys: list(process.env.ANTHROPIC_API_KEY),
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
  },

  gemini: {
    apiKeys: list(process.env.GEMINI_API_KEY),
    // Gemini exposes an OpenAI-compatible endpoint.
    baseUrl:
      process.env.GEMINI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/openai',
  },

  // How long a rate-limited (429) API key is rested before being retried.
  keyCooldownMs: int(process.env.KEY_COOLDOWN_SECONDS, 60) * 1000,

  tokenSaver: {
    enabled: bool(process.env.TOKEN_SAVER_ENABLED, false),
    // Keep at most this many non-system messages (most recent kept). null = no cap.
    maxMessages:
      process.env.TOKEN_SAVER_MAX_MESSAGES !== undefined
        ? int(process.env.TOKEN_SAVER_MAX_MESSAGES, 0)
        : null,
    // Drop oldest messages until estimated input tokens fit under this. null = off.
    maxInputTokens:
      process.env.TOKEN_SAVER_MAX_INPUT_TOKENS !== undefined
        ? int(process.env.TOKEN_SAVER_MAX_INPUT_TOKENS, 0)
        : null,
    // Collapse runs of whitespace in message content.
    trimWhitespace: bool(process.env.TOKEN_SAVER_TRIM_WHITESPACE, true),
  },

  cache: {
    enabled: bool(process.env.CACHE_ENABLED, true),
    ttlSeconds: int(process.env.CACHE_TTL_SECONDS, 300),
    maxEntries: int(process.env.CACHE_MAX_ENTRIES, 500),
  },

  rateLimit: {
    enabled: bool(process.env.RATE_LIMIT_ENABLED, true),
    windowSeconds: int(process.env.RATE_LIMIT_WINDOW_SECONDS, 60),
    maxRequests: int(process.env.RATE_LIMIT_MAX_REQUESTS, 30),
  },

  reliability: {
    timeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 30000),
    // How many times to retry the SAME provider on a transient error
    // before falling back to the next provider.
    retryMax: int(process.env.RETRY_MAX, 2),
    retryBaseMs: int(process.env.RETRY_BASE_MS, 300),
    // Circuit breaker: after this many consecutive failures a provider is
    // skipped ("open") until the cooldown elapses.
    circuitThreshold: int(process.env.CIRCUIT_FAILURE_THRESHOLD, 5),
    circuitCooldownMs: int(process.env.CIRCUIT_COOLDOWN_SECONDS, 30) * 1000,
  },

  budget: {
    enabled: bool(process.env.BUDGET_ENABLED, true),
    // Per-key daily limits. null = unlimited. Per-key overrides live in
    // budgets.json; these are the defaults for keys without an override.
    defaultDailyRequests:
      process.env.DEFAULT_DAILY_REQUESTS !== undefined
        ? int(process.env.DEFAULT_DAILY_REQUESTS, 0)
        : null,
    defaultDailyCostUsd:
      process.env.DEFAULT_DAILY_COST_USD !== undefined
        ? parseFloat(process.env.DEFAULT_DAILY_COST_USD)
        : null,
  },

  logging: {
    toFile: bool(process.env.LOG_TO_FILE, true),
    dir: process.env.LOG_DIR || 'logs',
  },
};
