import { config } from '../config.js';
import { estimateMessagesTokens, estimateTokens } from '../services/cost.js';

/**
 * OpenAI provider. Talks to the standard /chat/completions endpoint.
 * Works with any OpenAI-compatible base URL (Azure OpenAI, local servers, etc.)
 * by overriding OPENAI_BASE_URL.
 */
export const openaiProvider = {
  name: 'openai',

  isConfigured() {
    return Boolean(config.openai.apiKey);
  },

  async chatCompletion({ body, signal }) {
    const res = await fetch(`${config.openai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: false }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    return {
      model: data.model || body.model,
      content: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? 'stop',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? estimateMessagesTokens(body.messages),
        outputTokens:
          data.usage?.completion_tokens ?? estimateTokens(choice?.message?.content ?? ''),
      },
    };
  },

  async *streamCompletion({ body, signal }) {
    const res = await fetch(`${config.openai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
      // Ask OpenAI to include usage in the final streamed chunk.
      body: JSON.stringify({
        ...body,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let usage = null;
    let finishReason = 'stop';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep the incomplete trailing line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }

        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta?.content;
        if (json.choices?.[0]?.finish_reason) {
          finishReason = json.choices[0].finish_reason;
        }
        if (delta) {
          fullText += delta;
          yield { type: 'delta', text: delta };
        }
      }
    }

    yield {
      type: 'done',
      finishReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? estimateMessagesTokens(body.messages),
        outputTokens: usage?.completion_tokens ?? estimateTokens(fullText),
      },
    };
  },

  async embeddings({ input, model, signal }) {
    const res = await fetch(`${config.openai.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: JSON.stringify({ model, input }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    const vectors = (data.data || [])
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    const inputs = Array.isArray(input) ? input : [input];
    return {
      model: data.model || model,
      vectors,
      usage: {
        inputTokens:
          data.usage?.prompt_tokens ??
          inputs.reduce((s, t) => s + estimateTokens(String(t)), 0),
      },
    };
  },
};
