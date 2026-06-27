import express from 'express';
import { PRICING } from '../services/cost.js';
import { router } from '../routing/router.js';

export const modelsRouter = express.Router();

/** Best-effort owner inference from a model name prefix. */
function ownerOf(id) {
  if (id.startsWith('gemini') || id.startsWith('text-embedding-004')) return 'google';
  if (id.startsWith('gpt') || id.startsWith('text-embedding-3') || id === 'text-embedding-ada-002')
    return 'openai';
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('mock')) return 'mock';
  return 'gateway';
}

/**
 * OpenAI-compatible model listing. Surfaces:
 *  - aliases defined in routes.json (with what they route to)
 *  - models that have explicit routes
 *  - known models from the pricing table
 *
 * Any other model name still works via default routing, but listing these
 * gives clients a useful, discoverable catalogue.
 */
modelsRouter.get('/models', (req, res) => {
  const seen = new Map(); // id -> entry

  const add = (id, extra = {}) => {
    if (!seen.has(id)) {
      seen.set(id, { id, object: 'model', owned_by: ownerOf(id), ...extra });
    }
  };

  // Aliases first (clearly marked).
  for (const [alias, target] of Object.entries(router.aliases)) {
    add(alias, { owned_by: 'alias', routes_to: target });
  }
  // Explicitly routed models.
  for (const id of Object.keys(router.models)) add(id);
  // Known/priced models.
  for (const id of Object.keys(PRICING)) add(id);

  res.json({ object: 'list', data: [...seen.values()] });
});
