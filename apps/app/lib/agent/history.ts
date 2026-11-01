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
