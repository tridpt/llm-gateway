# Changelog

All notable changes to LLM Gateway are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Community health files: `CONTRIBUTING.md`, `SECURITY.md`, this changelog,
  issue templates, and a pull request template.
- ESLint (flat config) and Prettier with `lint` / `format` npm scripts.
- Dependabot config and a `lint` job in CI.

## [1.0.0]

### Added

- OpenAI-compatible `/v1/chat/completions` with streaming (SSE) support.
- Multi-provider fallback across mock, OpenAI, Anthropic, and Gemini adapters.
- Smart routing: model aliases, tiered routing, weighted round-robin load
  balancing, and latency-based routing via `routes.json`.
- Key rotation pool with per-key cooldown on rate-limit responses.
- Reliability layer: per-request timeouts, retry with exponential backoff, and
  a per-provider circuit breaker.
- Response caching (TTL + LRU) with streamed replay of cached answers.
- Per-request token counting and USD cost accounting.
- Sliding-window rate limiting per gateway key.
- Daily request-count and cost budgets/quotas per key, enforced with HTTP 429.
- Token saver: history trimming and whitespace collapsing to cut input tokens.
- OpenAI-compatible `/v1/embeddings` plus a semantic-search demo.
- Anthropic-compatible `/v1/messages` endpoint (translated in and out).
- Self-hosted team chat UI at `/chat` with username/password login, per-member
  budgets, and cross-device conversation sync.
- Encryption at rest (AES-256-GCM) for `team.json` and `conversations.json`.
- Observability: structured JSONL logs, a live dashboard, and a Prometheus
  `/metrics` endpoint.
- Docker image and `docker-compose.yml`, smoke-tested in CI.
- Continuous integration (GitHub Actions) running the test suite on Node 20 and 22.
- API, configuration, and architecture documentation under `docs/`, plus a
  Vietnamese deep-dive in `TAI_LIEU.md`.

[Unreleased]: https://github.com/tridpt/llm-gateway/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tridpt/llm-gateway/releases/tag/v1.0.0
