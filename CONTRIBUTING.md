# Contributing to LLM Gateway

Thanks for your interest! LLM Gateway is a dependency-light project: Node.js
(ESM) and Express on the server, plain HTML/CSS/JavaScript for the dashboard and
chat UI. Providers are thin `fetch` adapters — there are no AI SDK dependencies
and no build step.

For a detailed technical walkthrough (in Vietnamese), see [`TAI_LIEU.md`](TAI_LIEU.md).
See also the [Architecture & Design](docs/ARCHITECTURE.md) doc.

## Getting started

Requires Node.js 20 or newer.

```bash
npm ci        # install dependencies from the lockfile
cp .env.example .env
npm start     # run the gateway at http://localhost:8080
npm run dev   # run with --watch (auto-restart on changes)
npm test      # run the test suite (node --test, mock provider)
npm run lint  # lint the source with ESLint
```

The default config uses the **mock provider**, so it runs with no API keys and
no cost. Tests also run fully offline against the mock provider.

## How to contribute

1. Fork the repo and create a branch: `git checkout -b feature/your-feature`.
2. Make your change. Match the existing style (ESM modules, thin provider
   adapters under `src/providers/`, services under `src/services/`, one concern
   per file).
3. Add or update tests under `test/` when you change behavior.
4. Run `npm test` and `npm run lint` and make sure everything passes.
5. Commit with a clear message and open a Pull Request describing what and why.

## Good first contributions

- **Add a provider adapter** — model an existing one in `src/providers/`
  (`openai.js`, `gemini.js`) and wire it into `src/providers/index.js`.
- **Improve token accounting** — the char-based estimate in `src/services/cost.js`
  could use a real tokenizer for non-OpenAI paths.
- **Extend routing** — new strategies live in `src/routing/router.js`.
- **Dashboard polish** — the observability UI is `public/index.html`.

## Guidelines

- Keep providers as thin `fetch` adapters; don't pull in AI SDKs.
- Validate all client input on the server; never trust client-provided data.
- Never commit secrets (`.env`, real API keys) or the runtime stores
  (`team.json`, `conversations.json`, `logs/`).
- Keep `team.json` and `conversations.json` out of version control — they hold
  member credentials and chat history.
- Update the docs (`README.md`, `docs/`, `TAI_LIEU.md`) when behavior changes.

## Code of Conduct

By participating in this project you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting security issues

Please do not open a public issue for security problems. See [`SECURITY.md`](SECURITY.md).
