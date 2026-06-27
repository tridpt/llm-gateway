// Preloaded before any test module (via `node --import`).
// Forces a deterministic, offline configuration so tests never depend on
// real provider keys, network access, or the local .env file.
process.env.PROVIDER_ORDER = 'mock';
process.env.GATEWAY_API_KEYS = 'demo-key-123';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.BUDGET_ENABLED = 'false';
process.env.TOKEN_SAVER_ENABLED = 'false';
process.env.LOG_TO_FILE = 'false';
