import { estimateMessagesTokens, estimateTokens } from '../services/cost.js';

/**
 * Mock provider — lets you run and test the whole gateway with no API keys
 * and no cost. It echoes a deterministic answer derived from the last user
 * message, and reports plausible token usage.
 *
 * Every provider implements this contract:
 *   - name: string
 *   - isConfigured(): boolean
 *   - chatCompletion({ body, signal }) -> { model, content, finishReason, usage }
 *   - streamCompletion({ body, signal }) -> async generator of:
 *         { type: 'delta', text } ... { type: 'done', finishReason, usage }
 */
export const mockProvider = {
  name: 'mock',

  isConfigured() {
    return true;
  },

  _answer(body) {
    const messages = body.messages || [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '(no user message)';
    return `[mock:${body.model || 'mock-gpt'}] You said: "${String(prompt).slice(0, 200)}". This is a simulated response from the LLM gateway.`;
  },

  async chatCompletion({ body }) {
    const content = this._answer(body);
    const inputTokens = estimateMessagesTokens(body.messages);
    const outputTokens = estimateTokens(content);
    return {
      model: body.model || 'mock-gpt',
      content,
      finishReason: 'stop',
      usage: { inputTokens, outputTokens },
    };
  },

  async *streamCompletion({ body }) {
    const content = this._answer(body);
    const words = content.split(' ');
    const inputTokens = estimateMessagesTokens(body.messages);

    for (const word of words) {
      // Small delay to simulate token streaming.
      await new Promise((r) => setTimeout(r, 15));
      yield { type: 'delta', text: word + ' ' };
    }

    yield {
      type: 'done',
      finishReason: 'stop',
      usage: { inputTokens, outputTokens: estimateTokens(content) },
    };
  },

  async embeddings({ input }) {
    const inputs = Array.isArray(input) ? input : [input];
    const vectors = inputs.map((t) => mockEmbed(String(t)));
    const inputTokens = inputs.reduce((s, t) => s + estimateTokens(String(t)), 0);
    return { model: 'mock-embed', vectors, usage: { inputTokens } };
  },
};

/**
 * Deterministic pseudo-embedding: hash the text into a seed, generate a fixed
 * dimension vector with a small seeded PRNG, then L2-normalize it. Same text
 * always yields the same vector, and similar texts share leading tokens, which
 * is enough to demo semantic search / RAG end-to-end without any API.
 */
const EMBED_DIM = 384;

function mockEmbed(text) {
  // FNV-1a hash → 32-bit seed.
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  // Mulberry32 PRNG seeded by the hash.
  let state = seed >>> 0;
  const rand = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const vec = new Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    const v = rand() * 2 - 1; // [-1, 1]
    vec[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}
