import { estimateMessagesTokens, estimateTokens } from './cost.js';

/**
 * Token saver — trims a chat request to reduce input tokens (and therefore
 * cost and latency) before it reaches a provider. This is the gateway-side
 * equivalent of the "token saver" features in routers like 9router.
 *
 * Rules (all opt-in via config):
 *   - System messages are always preserved (they carry instructions).
 *   - Whitespace in message content can be collapsed.
 *   - Conversation history is trimmed to the most recent N messages.
 *   - History is further trimmed (oldest first) to fit a token budget.
 *   - The most recent message is never dropped, so a request stays valid.
 *
 * Pure function: returns a new messages array plus stats. Does not mutate input.
 */
export function applyTokenSaver(messages = [], opts = {}) {
  const { maxMessages = null, maxInputTokens = null, trimWhitespace = false } = opts;

  const tokensBefore = estimateMessagesTokens(messages);

  // 1. Optionally collapse whitespace.
  let working = messages.map((m) => {
    if (trimWhitespace && typeof m.content === 'string') {
      return { ...m, content: m.content.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim() };
    }
    return { ...m };
  });

  // 2. Split system (kept) from conversation (trimmable), preserving order via index.
  const systems = [];
  const convo = [];
  working.forEach((m, index) => {
    if (m.role === 'system') systems.push({ m, index });
    else convo.push({ m, index });
  });

  let droppedMessages = 0;

  // 3. Cap by message count (keep the most recent ones).
  let keptConvo = convo;
  if (maxMessages != null && convo.length > maxMessages) {
    droppedMessages += convo.length - maxMessages;
    keptConvo = convo.slice(convo.length - maxMessages);
  }

  // 4. Cap by token budget (drop oldest convo messages, never the last one).
  if (maxInputTokens != null) {
    const systemTokens = systems.reduce(
      (s, { m }) => s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) + 4,
      0
    );
    while (keptConvo.length > 1) {
      const current = systemTokens + estimateMessagesTokens(keptConvo.map((x) => x.m));
      if (current <= maxInputTokens) break;
      keptConvo = keptConvo.slice(1); // drop oldest
      droppedMessages += 1;
    }
  }

  // 5. Reassemble in original positional order.
  const finalMessages = [...systems, ...keptConvo]
    .sort((a, b) => a.index - b.index)
    .map((x) => x.m);

  const tokensAfter = estimateMessagesTokens(finalMessages);

  return {
    messages: finalMessages,
    stats: {
      droppedMessages,
      tokensBefore,
      tokensAfter,
      tokensSaved: Math.max(0, tokensBefore - tokensAfter),
    },
  };
}
