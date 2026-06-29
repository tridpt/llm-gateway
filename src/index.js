import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './services/logger.js';
import { metrics } from './services/metrics.js';
import { authenticate } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { budgetGuard } from './middleware/budget.js';
import { budgetManager } from './services/budget.js';
import { team } from './services/team.js';
import { chatRouter } from './routes/chat.js';
import { embeddingsRouter } from './routes/embeddings.js';
import { modelsRouter } from './routes/models.js';
import { anthropicRouter } from './routes/anthropic.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { usageRouter } from './routes/usage.js';
import { conversationsRouter } from './routes/conversations.js';
import { resolveProviderChain } from './providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Team members' per-person daily limits take precedence over budgets.json /
  // defaults. Wired here (not inside budget.js) to avoid an import cycle.
  budgetManager.limitResolver = (key) => team.getLimits(key);

  // Health check (no auth) — useful for load balancers and uptime monitors.
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      activeProviders: resolveProviderChain().map((p) => p.name),
    });
  });

  // Prometheus scrape endpoint (text exposition format, unauthenticated by
  // convention so scrapers can read it). Pair with Grafana for dashboards.
  app.get('/metrics', (req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    const budgetText = budgetManager.toPrometheus((key) => team.get(key)?.name);
    res.send(metrics.toPrometheus() + budgetText);
  });

  // Static observability dashboard.
  app.use('/dashboard', express.static(path.join(__dirname, '..', 'public')));

  // Self-hosted team chat UI (a "ChatGPT for your team" front end that talks
  // to this gateway: shared provider keys, per-user budgets).
  app.use('/chat', express.static(path.join(__dirname, '..', 'public', 'chat')));

  // Browser login: username/password -> signed session token.
  app.use('/v1', authRouter);

  // LLM API — authenticated, budget-checked, and rate limited.
  app.use('/v1', authenticate, budgetGuard, rateLimit, chatRouter);
  app.use('/v1', authenticate, budgetGuard, rateLimit, embeddingsRouter);
  app.use('/v1', authenticate, budgetGuard, rateLimit, anthropicRouter);
  // Model catalogue + self-service usage — authenticated only (cheap, not metered).
  app.use('/v1', authenticate, modelsRouter);
  app.use('/v1', authenticate, usageRouter);
  // Conversation sync — authenticated, scoped to the caller's key.
  app.use('/v1', authenticate, conversationsRouter);

  // Admin/observability — authenticated (reuses gateway keys).
  app.use('/admin', authenticate, adminRouter);

  app.get('/', (req, res) => {
    res.json({
      name: 'llm-gateway',
      endpoints: {
        chat: 'POST /v1/chat/completions',
        embeddings: 'POST /v1/embeddings',
        messages: 'POST /v1/messages (Anthropic-compatible)',
        models: 'GET /v1/models',
        usage: 'GET /v1/usage (your own budget)',
        metrics: 'GET /admin/metrics',
        prometheus: 'GET /metrics',
        dashboard: 'GET /dashboard',
        teamChat: 'GET /chat',
        health: 'GET /health',
      },
    });
  });

  return app;
}

// Only start listening when run directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const app = createApp();
  app.listen(config.port, () => {
    logger.info('LLM gateway started', {
      port: config.port,
      providers: resolveProviderChain().map((p) => p.name),
      authEnabled: config.gatewayApiKeys.length > 0,
      cacheEnabled: config.cache.enabled,
      rateLimitEnabled: config.rateLimit.enabled,
    });
    console.log(`\n  LLM Gateway  →  http://localhost:${config.port}`);
    console.log(`  Dashboard    →  http://localhost:${config.port}/dashboard\n`);
  });
}
