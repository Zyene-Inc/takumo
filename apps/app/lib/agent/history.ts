import type { UIMessage } from "@repo/ai";

/** Questions whose tool results the model still sees in full. */
export const FULL_TURNS = 3;
/** After this many questions the composer suggests a new conversation. */
export const LONG_CONVERSATION = 20;

/**
 * What the model sees of a conversation: the last few questions in full, and
 * only the written answers before that. Old tool results (SQL rows, plans,
 * estimates) are what make long conversations expensive, and the answers
 * already say what they found; the agent re-runs a tool if it needs the data
 * again. Pure, so tested.
 */
export const compactHistory = <M extends Pick<UIMessage, "parts" | "role">>(
  messages: M[],
  fullTurns = FULL_TURNS
) => {
  let seen = 0;
  let firstFull = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      seen += 1;
      if (seen === fullTurns) {
        firstFull = i;
        break;
      }
    }
  }
  return messages.flatMap((message, i) => {
    if (i >= firstFull || message.role !== "assistant") {
      return [message];
    }
    const parts = message.parts.filter((part) => part.type === "text");
    return parts.length ? [{ ...message, parts }] : [];
  });
};

/** Takumo's instructions and tool definitions, sent with every question. */
const BASE_TOKENS = 3500;
/**
 * The context the ring fills towards. Gemini accepts far more, but answers
 * stay sharpest (and cheapest) well below this; past it, start a new chat.
 */
export const CONTEXT_BUDGET = 50_000;

/** About how many tokens the next question will start with (≈4 chars each). */
export const estimateContextTokens = (
  messages: Pick<UIMessage, "parts" | "role">[]
) =>
  messages.length === 0
    ? 0
    : BASE_TOKENS +
      Math.round(JSON.stringify(compactHistory(messages)).length / 4);

/** When the composer suggests a new chat: many questions, or a full context. */
export const isLongConversation = (questions: number, tokens: number) =>
  questions >= LONG_CONVERSATION || tokens >= CONTEXT_BUDGET * 0.8;
