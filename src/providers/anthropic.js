import { config } from '../config.js';
import { estimateMessagesTokens, estimateTokens } from '../services/cost.js';

/**
 * Anthropic (Claude) provider.
 *
 * The gateway speaks the OpenAI request shape, so this adapter translates
 * OpenAI-style { messages } into Anthropic's /v1/messages format:
 *   - "system" messages are hoisted into a top-level `system` field
 *   - `max_tokens` is required by Anthropic, so we default it
 */
const ANTHROPIC_VERSION = '2023-06-01';

function toAnthropicPayload(body) {
  const system = (body.messages || [])
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

  const messages = (body.messages || [])
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  return {
    model: body.model,
    system: system || undefined,
    messages,
    max_tokens: body.max_tokens ?? 1024,
    temperature: body.temperature,
    top_p: body.top_p,
  };
}

export const anthropicProvider = {
  name: 'anthropic',

  isConfigured() {
    return Boolean(config.anthropic.apiKey);
  },

  _headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  },

  async chatCompletion({ body, signal }) {
    const payload = toAnthropicPayload(body);
    const res = await fetch(`${config.anthropic.baseUrl}/messages`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ ...payload, stream: false }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    const content = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      model: data.model || body.model,
      content,
      finishReason: data.stop_reason || 'stop',
      usage: {
        inputTokens: data.usage?.input_tokens ?? estimateMessagesTokens(body.messages),
        outputTokens: data.usage?.output_tokens ?? estimateTokens(content),
      },
    };
  },

  async *streamCompletion({ body, signal }) {
    const payload = toAnthropicPayload(body);
    const res = await fetch(`${config.anthropic.baseUrl}/messages`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let inputTokens = estimateMessagesTokens(body.messages);
    let outputTokens = 0;
    let finishReason = 'stop';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payloadStr = trimmed.slice(5).trim();
        if (!payloadStr) continue;

        let json;
        try {
          json = JSON.parse(payloadStr);
        } catch {
          continue;
        }

        if (json.type === 'message_start') {
          inputTokens = json.message?.usage?.input_tokens ?? inputTokens;
        } else if (json.type === 'content_block_delta' && json.delta?.text) {
          fullText += json.delta.text;
          yield { type: 'delta', text: json.delta.text };
        } else if (json.type === 'message_delta') {
          if (json.usage?.output_tokens) outputTokens = json.usage.output_tokens;
          if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
        }
      }
    }

    yield {
      type: 'done',
      finishReason,
      usage: {
        inputTokens,
        outputTokens: outputTokens || estimateTokens(fullText),
      },
    };
  },
};
