# Configuration Reference

Configuration comes from environment variables (loaded from `.env` at the
project root) plus two optional JSON files: `routes.json` and `budgets.json`.
Real environment variables always win over `.env`.

## Environment variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port. |
| `GATEWAY_API_KEYS` | _(empty)_ | Comma-separated keys clients must send as `Bearer`. Empty = auth disabled (dev only). |

### Providers

| Variable | Default | Description |
|----------|---------|-------------|
| `PROVIDER_ORDER` | `mock` | Comma-separated providers to use: `mock`, `openai`, `anthropic`, `gemini`. |
| `OPENAI_API_KEY` | _(empty)_ | One or more comma-separated keys (rotated). |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for OpenAI-compatible servers. |
| `ANTHROPIC_API_KEY` | _(empty)_ | One or more comma-separated keys. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | |
| `GEMINI_API_KEY` | _(empty)_ | One or more comma-separated keys. Has a free tier. |
| `GEMINI_BASE_URL` | `…/v1beta/openai` | Gemini's OpenAI-compatible endpoint. |
| `KEY_COOLDOWN_SECONDS` | `60` | How long a 429'd key rests before reuse. |

### Routing

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTING_STRATEGY` | `tier` | Same-tier ordering: `tier` (weighted round-robin) or `latency`. |

### Cache

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_ENABLED` | `true` | |
| `CACHE_TTL_SECONDS` | `300` | Entry lifetime. |
| `CACHE_MAX_ENTRIES` | `500` | LRU bound. |

### Rate limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Sliding window length. |
| `RATE_LIMIT_MAX_REQUESTS` | `30` | Max requests per key per window. |

### Reliability

| Variable | Default | Description |
|----------|---------|-------------|
| `REQUEST_TIMEOUT_MS` | `30000` | Per-attempt timeout. |
| `RETRY_MAX` | `2` | Retries of the same provider on transient errors. |
| `RETRY_BASE_MS` | `300` | Backoff base (exponential + jitter). |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | Consecutive failures before a provider circuit opens. |
| `CIRCUIT_COOLDOWN_SECONDS` | `30` | How long a circuit stays open. |

### Budgets

| Variable | Default | Description |
|----------|---------|-------------|
| `BUDGET_ENABLED` | `true` | |
| `DEFAULT_DAILY_REQUESTS` | _(unset = unlimited)_ | Default per-key daily request quota. |
| `DEFAULT_DAILY_COST_USD` | _(unset = unlimited)_ | Default per-key daily cost budget. |

### Token saver

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKEN_SAVER_ENABLED` | `false` | Trim requests before sending upstream. |
| `TOKEN_SAVER_MAX_MESSAGES` | _(unset = no cap)_ | Keep N most-recent non-system messages. |
| `TOKEN_SAVER_MAX_INPUT_TOKENS` | _(unset = off)_ | Drop oldest messages to fit this budget. |
| `TOKEN_SAVER_TRIM_WHITESPACE` | `true` | Collapse whitespace in content. |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_TO_FILE` | `true` | Write JSONL logs to disk (off in containers). |
| `LOG_DIR` | `logs` | Log directory. |

## routes.json

Optional. Maps requested model names (or aliases) to ordered route targets.

```json
{
  "strategy": "tier",
  "tiers": ["free", "cheap", "premium", "fallback"],
  "aliases": { "fast": "gemini-2.5-flash-lite", "smart": "gemini-2.5-pro" },
  "models": {
    "gemini-2.5-flash-lite": [
      { "provider": "gemini", "model": "gemini-2.5-flash-lite", "tier": "free" },
      { "provider": "mock",   "model": "mock-gpt",              "tier": "fallback" }
    ],
    "balanced": [
      { "provider": "gemini", "model": "gemini-2.5-flash-lite", "tier": "free", "weight": 2 },
      { "provider": "mock",   "model": "mock-gpt",              "tier": "free", "weight": 1 }
    ]
  }
}
```

- `tiers` — preference order; targets are tried tier by tier.
- `aliases` — virtual model name → canonical model name.
- `models[name]` — ordered targets; `weight` controls round-robin share.
- A model not listed here uses default routing: every provider in
  `PROVIDER_ORDER` is tried with the requested model name.

## budgets.json

Optional. Per-key daily limits; keys without an override use the env defaults.

```json
{
  "default": { "dailyRequests": 1000, "dailyCostUsd": 1.0 },
  "keys": {
    "limited-key": { "dailyRequests": 3, "dailyCostUsd": 0.001 }
  }
}
```

A `null` (or unset) limit means unlimited. Usage resets at UTC midnight.
