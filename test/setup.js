// Preloaded before any test module (via `node --import`).
// Forces a deterministic, offline configuration so tests never depend on
// real provider keys, network access, or the local .env file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PROVIDER_ORDER = 'mock';
process.env.GATEWAY_API_KEYS = 'demo-key-123';
process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
process.env.BUDGET_ENABLED = 'false';
process.env.TOKEN_SAVER_ENABLED = 'false';
process.env.LOG_TO_FILE = 'false';

// Point the runtime stores at throwaway temp files so tests never touch the
// repo's team.json / conversations.json. Start each run from a clean slate.
process.env.TEAM_FILE = path.join(os.tmpdir(), 'llmgw-test-team.json');
process.env.CONVERSATIONS_FILE = path.join(os.tmpdir(), 'llmgw-test-conversations.json');
for (const f of [process.env.TEAM_FILE, process.env.CONVERSATIONS_FILE]) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}
