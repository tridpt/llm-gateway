# Architecture & Design

## Overview

The gateway is a stateless HTTP service (Express, ESM) that sits between client
applications and LLM providers. It speaks the OpenAI and Anthropic request
shapes, normalizes them to a single internal format, and runs every request
through a consistent pipeline of cross-cutting concerns.

There are zero AI SDK dependencies — providers are thin `fetch` adapters — which
keeps the data flow explicit and easy to reason about.

## Request lifecycle

```
client ──► /v1/chat/completions | /v1/messages | /v1/embeddings
  1. auth            (Bearer key → req.clientKey)
  2. budget guard    (per-key daily request + cost limits; 429 if exceeded)
  3. rate limit      (per-key sliding window; 429 if exceeded)
  4. (chat) token saver — trim history/whitespace
  5. cache lookup    → hit ─► return (cost $0)
  6. routing         — alias resolution, tier ordering, load balance / latency
  7. execute targets — per target: timeout → retry+backoff → circuit breaker
                       → on failure, fall back to next target
  8. accounting      — token counting, cost, budget debit
  9. observability   — metrics, JSONL logs, Prometheus
```

## Module map

| Concern | Module |
|---------|--------|
| Server wiring, middleware order | `src/index.js` |
| Env + JSON config loading | `src/config.js` |
| Provider adapters | `src/providers/{mock,openai,anthropic,gemini}.js` |
| Target execution + fallback | `src/providers/index.js` |
| Routing (alias/tier/LB/latency) | `src/routing/router.js` |
| Latency tracking (EWMA) | `src/services/latency.js` |
| API key rotation | `src/services/keypool.js` |
| Reliability (timeout/retry/circuit) | `src/services/reliability.js` |
| Cache (TTL + LRU) | `src/services/cache.js` |
| Cost & token estimation | `src/services/cost.js` |
| Budgets / quotas | `src/services/budget.js` |
| Token saver | `src/services/tokenSaver.js` |
| Metrics | `src/services/metrics.js` |
| Structured logging | `src/services/logger.js` |
| Routes | `src/routes/{chat,embeddings,anthropic,models,admin}.js` |

## Key design decisions

**OpenAI request shape as the internal format.** The ecosystem speaks OpenAI,
so adapters translate to/from it. Inbound Anthropic requests are converted to
this internal shape, and responses are converted back — the gateway is a
two-way adapter.

**Providers are thin adapters.** Each implements a small contract
(`chatCompletion`, `streamCompletion`, optional `embeddings`) and returns a
normalized result. Adding a provider is a single file.

**Routing produces an ordered target list.** A "target" is a concrete
`{provider, model, tier}`. The router expands aliases, orders by tier, and
applies load balancing (weighted round-robin) or latency ordering within a
tier. The execution layer then iterates that list with fallback.

**Reliability is layered, per target.** Each attempt gets a timeout; transient
errors (429/5xx/timeouts) retry the same target with exponential backoff before
moving on; a circuit breaker skips a provider that keeps failing. Only after
that does the request fall back to the next target.

**Streaming commits after the first chunk.** Fallback during streaming is only
possible before any bytes are sent — you cannot cleanly swap providers
mid-stream. `openStreamAcrossTargets` encapsulates this and is shared by the
OpenAI and Anthropic streaming paths.

**Key rotation pools quota.** Each provider can hold multiple API keys, rotated
round-robin; a key that returns 429 is rested for a cooldown. Combined with
retry, a single 429 transparently rotates to another key.

**Cost control at two layers.** Token saver reduces input size before the call;
per-key budgets cap daily spend and request count after the fact.

## State & scaling

All state is in-memory: cache, rate-limit windows, circuit-breaker counters,
budget usage, latency stats, and key cooldowns. This is correct for a single
instance. To run multiple instances behind a load balancer, move this shared
state into Redis — the module interfaces are designed so only the storage layer
changes, not the call sites.

Token counts use a character-based estimate when a provider does not return
usage. For exact accounting on non-OpenAI paths, swap in a real tokenizer
(e.g. `tiktoken`).

## Testing

The suite (`node --test`) runs fully offline against the mock provider via
`test/setup.js`, which forces a deterministic config (mock-only, budgets and
token saver disabled, high rate limits). Pure logic (router, key pool, budget,
token saver, reliability) is unit-tested directly; routes are tested against an
ephemeral server.
