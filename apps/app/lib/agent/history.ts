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
export const SETUP_TOKENS = 3500;
/**
 * Past this, answers get slower and dearer (Gemini bills long prompts at a
 * higher rate) and the model is easier to distract: suggest a new chat.
 */
export const LONG_CONTEXT = 200_000;

/** Context windows from Google's Vertex AI model pages (November 2026). */
const MODELS: { label: string; prefix: string; window: number }[] = [
  { prefix: "gemini-4-argon", label: "Gemini 4 Argon", window: 1_048_576 },
  { prefix: "gemini-3.8-flash", label: "Gemini 3.8 Flash", window: 1_048_576 },
  {
    prefix: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    window: 1_048_576,
  },
];

export const modelInfo = (modelId: string) =>
  MODELS.find((m) => modelId.startsWith(m.prefix)) ?? null;

/** What an answer's last model call was sent, saved with the answer. */
export interface ContextUse {
  model: string;
  tokens: number;
}

/** A hidden part on saved answers, so a reopened chat shows its context. */
export const CONTEXT_PART = "data-context";

/** About how many tokens the next question will start with (≈4 chars each). */
export const estimateContextTokens = (
  messages: Pick<UIMessage, "parts" | "role">[]
) =>
  messages.length === 0
    ? 0
    : SETUP_TOKENS +
      Math.round(JSON.stringify(compactHistory(messages)).length / 4);

/**
 * The conversation's context as the model last saw it: the real token count
 * Gemini reported for the latest answer, or an estimate for answers saved
 * before that was recorded.
 */
export const conversationContext = (
  messages: Pick<UIMessage, "metadata" | "parts" | "role">[]
): (ContextUse & { estimated: boolean }) | null => {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  const used = (last?.metadata as { context?: ContextUse } | undefined)
    ?.context;
  if (used?.tokens) {
    return { ...used, estimated: false };
  }
  const tokens = estimateContextTokens(messages);
  return tokens ? { model: "", tokens, estimated: true } : null;
};

/** When the composer suggests a new chat: many questions, or a long context. */
export const isLongConversation = (
  questions: number,
  context: { tokens: number } | null
) => questions >= LONG_CONVERSATION || (context?.tokens ?? 0) >= LONG_CONTEXT;
