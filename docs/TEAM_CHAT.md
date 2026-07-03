# Team chat (self-hosted ChatGPT)

A ready-to-use chat UI ships at **`/chat`** — a "ChatGPT for your team" front end
that runs entirely on top of the gateway. The provider API keys stay on the
server (shared), while each team member signs in with their **own gateway key**,
so usage and cost count against that person's daily budget.

**Login:** the chat UI defaults to username/password login. Admins create
members from the Team panel, copy an invite with URL + username + password, and
users receive a signed session token from `POST /v1/login`. The old gateway-key
login remains available under "API key" for bootstrap/admin operators and API
clients.

Open <http://localhost:8080/chat> and sign in with a gateway key (e.g.
`demo-key-123`). The UI is a single static page (vanilla JS, no build step) that:

- streams replies over SSE from `/v1/chat/completions`
- keeps multiple conversations in the browser (scoped per key, never sent anywhere)
- lets you pick any model from `/v1/models` and set a per-chat system prompt
- shows a live **budget bar** (requests + cost used vs. your daily limit), read
  from the `X-Budget-*` response headers and the self-service `GET /v1/usage`

Give each teammate a key in `budgets.json` with the limits you want, hand them
the URL, and you have a shared, cost-controlled chat without exposing the
upstream provider keys to anyone:

```json
{
  "default": { "dailyRequests": 200, "dailyCostUsd": 0.5 },
  "keys": {
    "alice-key": { "dailyRequests": 1000, "dailyCostUsd": 5.0 },
    "bob-key": { "dailyRequests": 100, "dailyCostUsd": 0.25 }
  }
}
```

`GET /v1/usage` returns only the calling key's own usage (unlike `/admin/usage`,
which lists everyone), so the chat UI can show a member their budget without
leaking other members' activity.

## Managing the team (no file editing, no restart)

Admins can create username/password logins, copy an invite, reset a member's
password, disable access, and still copy the underlying gateway key for advanced
API-client use. The stable member key remains the internal budget bucket.

Editing `budgets.json` by hand works, but the chat UI also ships a **team admin
panel** for provisioning people at runtime. Sign in with an **admin** key and a
"👥 Manage team" button appears in the sidebar. From there an admin can:

- **Add a member** — give a name and optional daily request / cost limits; the
  gateway generates their key (`sk-team-…`) and shows it once to hand over.
- **Set limits / disable / remove** — change a member's budget, temporarily
  disable their access, or delete them. Changes take effect immediately.
- **See per-member usage** — requests and cost spent today, next to each limit.

Who counts as an admin:

- any static `GATEWAY_API_KEYS` key (the operators who run the gateway), and
- any team member created with the **admin** flag.

Members are persisted to `team.json` (atomic write, git-ignored) so they survive
restarts. A member's key authenticates exactly like an env key but also carries
its own per-day limits — so the static `GATEWAY_API_KEYS` list is now just the
bootstrap/admin set, and everyday users are managed entirely from the UI.

## Conversation sync across devices

Chats are no longer trapped in one browser. When a member is signed in, the UI
syncs each conversation to the gateway (`PUT /v1/conversations/:id`) and loads
their history on launch (`GET /v1/conversations`), so the same person sees the
same chats on their laptop and phone. Conversations are scoped to the caller's
key — a member only ever sees their own — and `localStorage` is kept as an
offline cache and fallback when the server can't be reached.

History is stored server-side in `conversations.json` (atomic write,
git-ignored, capped per member). It's plaintext by default, so for any shared
deployment turn on **encryption at rest** (below); for a larger system back it
with a database and encryption at rest.

The dashboard at `/dashboard` links straight to the chat UI and shows a
**Team members** panel (when viewed with an admin key) with each member's
limits, role, status, and today's usage.

## Encryption at rest

The two JSON stores hold sensitive data — `team.json` contains members' gateway
**API keys** (credentials) and `conversations.json` contains chat history. Set
`DATA_ENCRYPTION_KEY` to a strong passphrase and both files are written as an
AES-256-GCM envelope instead of plaintext:

```ini
DATA_ENCRYPTION_KEY=change-me-to-a-long-random-secret
```

- **Authenticated** — GCM detects tampering; a modified or truncated file fails
  to load rather than returning corrupted data.
- **Transparent migration** — an existing plaintext file is read normally and
  re-written encrypted on its next change, so you can switch it on in place.
- **Back-compatible** — leave the key unset and the files stay plaintext (handy
  for local dev and inspection).

The 32-byte AES key is derived from your passphrase, so any length works. Manage
the key with a secrets manager in production, and note that **losing it makes
existing encrypted files unrecoverable**.
