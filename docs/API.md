# API Reference

Base URL (local): `http://localhost:8080`

All `/v1/*` endpoints require authentication. Send your gateway key as a bearer
token:

```
Authorization: Bearer <GATEWAY_API_KEY>
```

If `GATEWAY_API_KEYS` is empty, auth is disabled (local dev only) and every
caller is treated as `anonymous`.

## Conventions

- Request and response bodies are JSON unless streaming (Server-Sent Events).
- Errors use the shape `{ "error": { "message", "type", ... } }` for OpenAI-style
  endpoints, and `{ "type": "error", "error": { "type", "message" } }` for the
  Anthropic-style endpoint.
- Every chat/embedding response includes a `gateway` object with metadata such
  as `{ "cached": true }`.

---

## POST /v1/chat/completions

OpenAI-compatible chat completion. Supports streaming.

### Request

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | A model id or a routing alias (e.g. `fast`). |
| `messages` | array | yes | `{ role, content }` items. `role` ∈ system/user/assistant. |
| `stream` | boolean | no | When `true`, responds with SSE. |
| `temperature` | number | no | Forwarded to the provider. |
| `top_p` | number | no | Forwarded to the provider. |
| `max_tokens` | number | no | Forwarded to the provider. |

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer demo-key-123" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash-lite","messages":[{"role":"user","content":"hello"}]}'
```

### Response (non-streaming)

```json
{
  "id": "uuid",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "gemini-2.5-flash-lite",
  "gateway": { "cached": false },
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "Hi!" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11 }
}
```

### Response (streaming)

`Content-Type: text/event-stream`. Emits `chat.completion.chunk` objects, then
`data: [DONE]`:

```
data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}
data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"}}]}
data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

---

## POST /v1/embeddings

OpenAI-compatible embeddings. `input` may be a string or an array of strings.

```bash
curl -X POST http://localhost:8080/v1/embeddings \
  -H "Authorization: Bearer demo-key-123" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-embedding-001","input":["first","second"]}'
```

### Response

```json
{
  "object": "list",
  "model": "gemini-embedding-001",
  "gateway": { "cached": false },
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.01, -0.02, ...] },
    { "object": "embedding", "index": 1, "embedding": [0.03, 0.04, ...] }
  ],
  "usage": { "prompt_tokens": 4, "total_tokens": 4 }
}
```

Use `mock-embed` for offline, deterministic vectors (no key needed).

---

## POST /v1/messages

Anthropic-compatible Messages API. The gateway translates the request into its
internal format, runs the full pipeline, and translates the response back.

### Request

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | Model id or alias. |
| `messages` | array | yes | `content` may be a string or an array of `{type:"text",text}` blocks. |
| `system` | string/array | no | Hoisted into a system message internally. |
| `max_tokens` | number | no | Forwarded. |
| `stream` | boolean | no | When `true`, emits Anthropic SSE events. |

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Authorization: Bearer demo-key-123" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash-lite","max_tokens":100,"messages":[{"role":"user","content":"hello"}]}'
```

### Response (non-streaming)

```json
{
  "id": "msg_uuid",
  "type": "message",
  "role": "assistant",
  "model": "gemini-2.5-flash-lite",
  "content": [{ "type": "text", "text": "Hi!" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 8, "output_tokens": 3 }
}
```

### Response (streaming)

Emits the Anthropic event sequence: `message_start`, `content_block_start`,
`content_block_delta` (text deltas), `content_block_stop`, `message_delta`
(with `stop_reason` + output usage), `message_stop`.

---

## GET /v1/models

OpenAI-compatible model catalogue. Lists aliases (with `routes_to`), explicitly
routed models, and known/priced models.

```json
{
  "object": "list",
  "data": [
    { "id": "fast", "object": "model", "owned_by": "alias", "routes_to": "gemini-2.5-flash-lite" },
    { "id": "gemini-2.5-flash-lite", "object": "model", "owned_by": "google" }
  ]
}
```

---

## Admin & observability

These are also authenticated (reuse gateway keys), except `/metrics` and
`/health` which are open by convention.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness probe (no auth). |
| GET | `/metrics` | Prometheus exposition format (no auth). |
| GET | `/admin/metrics` | Full JSON metrics snapshot. |
| POST | `/admin/metrics/reset` | Reset counters. |
| POST | `/admin/cache/clear` | Empty the response cache. |
| GET | `/admin/pricing` | Pricing table (USD per 1M tokens). |
| GET | `/admin/routes` | Active routing config. |
| GET | `/admin/usage` | Per-key budget usage. |

### Error codes

| Status | Meaning |
|--------|---------|
| 400 | Invalid request body. |
| 401 | Missing/invalid gateway API key. |
| 429 | Rate limit or budget exceeded (`type`: `rate_limit_error` / `budget_exceeded`). |
| 502 | All providers/targets failed (includes `attempts`). |
| 503 | No usable providers configured. |

Rate-limit and budget responses include a `Retry-After` header.
