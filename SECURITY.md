# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue, pull
request, or discussion for a vulnerability.

- Use GitHub's [private vulnerability reporting](https://github.com/tridpt/llm-gateway/security/advisories/new) (Security tab → "Report a vulnerability"), or
- Contact the maintainer directly through their GitHub profile.

Please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected version or commit.

We aim to acknowledge reports within a few days and will keep you updated on the fix.

## Scope and notes

This project is an LLM gateway/proxy that sits between clients and upstream
providers. A few design points worth knowing:

- **Provider API keys** live only on the server (in `.env`) and are never sent
  to clients. Never commit `.env` or real keys.
- **Gateway auth** uses `Authorization: Bearer <key>`. The static
  `GATEWAY_API_KEYS` set is the bootstrap/admin set; everyday users are managed
  as team members with their own keys.
- **`team.json`** holds member gateway keys (credentials) and
  **`conversations.json`** holds chat history. Both are git-ignored. For any
  shared deployment, enable **encryption at rest** with `DATA_ENCRYPTION_KEY`
  (AES-256-GCM). Losing that key makes existing encrypted files unrecoverable.
- **Admin endpoints** (`/admin/*`) and team management require an admin key.
  Protect them and run the gateway behind HTTPS in production.
- Budgets, quotas, and rate limits are in-memory by default; for multi-instance
  deployments back them with a shared store (e.g. Redis) so limits hold across
  instances.

## Supported versions

The latest version on the `main` branch receives security fixes.
