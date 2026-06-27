/**
 * Mini semantic-search demo — proves the /v1/embeddings endpoint is enough to
 * build the retrieval half of a RAG pipeline.
 *
 * It embeds a tiny "knowledge base", embeds a query, and ranks documents by
 * cosine similarity — all through the gateway (caching + cost tracking apply).
 *
 * Usage:
 *   node examples/semantic-search.mjs "your question here"
 *
 * Env (optional):
 *   GATEWAY_URL   default http://localhost:8080
 *   GATEWAY_KEY   default demo-key-123
 *   EMBED_MODEL   default gemini-embedding-001  (use "mock-embed" for offline)
 */

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const KEY = process.env.GATEWAY_KEY || 'demo-key-123';
const MODEL = process.env.EMBED_MODEL || 'gemini-embedding-001';

const DOCS = [
  'Circuit breakers stop the gateway from repeatedly calling a provider that is failing.',
  'Response caching returns a stored answer for identical requests, saving cost and latency.',
  'Rate limiting uses a sliding window per API key to cap how many requests a client can make.',
  'The gateway tracks token usage and computes the dollar cost of every request.',
  'Streaming uses Server-Sent Events to deliver tokens to the client as they are generated.',
  'Hanoi is the capital of Vietnam and is known for its old quarter and street food.',
];

async function embed(input) {
  const res = await fetch(`${GATEWAY}/v1/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input }),
  });
  if (!res.ok) {
    throw new Error(`Gateway returned ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main() {
  const query = process.argv.slice(2).join(' ') || 'How does the gateway avoid calling a broken provider?';

  console.log(`\nModel: ${MODEL}`);
  console.log(`Query: ${query}\n`);

  // Batch-embed all documents in one call, then embed the query.
  const docVectors = await embed(DOCS);
  const [queryVector] = await embed(query);

  const ranked = DOCS.map((text, i) => ({ text, score: cosine(queryVector, docVectors[i]) }))
    .sort((a, b) => b.score - a.score);

  console.log('Top matches:');
  ranked.slice(0, 3).forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.score.toFixed(3)}] ${r.text}`);
  });
  console.log();
}

main().catch((err) => {
  console.error('Demo failed:', err.message);
  process.exit(1);
});
