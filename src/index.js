import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './services/logger.js';
import { authenticate } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { chatRouter } from './routes/chat.js';
import { embeddingsRouter } from './routes/embeddings.js';
import { adminRouter } from './routes/admin.js';
import { resolveProviderChain } from './providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Health check (no auth) — useful for load balancers and uptime monitors.
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      activeProviders: resolveProviderChain().map((p) => p.name),
    });
  });

  // Static observability dashboard.
  app.use('/dashboard', express.static(path.join(__dirname, '..', 'public')));

  // LLM API — authenticated + rate limited.
  app.use('/v1', authenticate, rateLimit, chatRouter);
  app.use('/v1', authenticate, rateLimit, embeddingsRouter);

  // Admin/observability — authenticated (reuses gateway keys).
  app.use('/admin', authenticate, adminRouter);

  app.get('/', (req, res) => {
    res.json({
      name: 'llm-gateway',
      endpoints: {
        chat: 'POST /v1/chat/completions',
        embeddings: 'POST /v1/embeddings',
        metrics: 'GET /admin/metrics',
        dashboard: 'GET /dashboard',
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
