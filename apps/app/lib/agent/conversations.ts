import "server-only";

import type { UIMessage } from "@repo/ai";
import { database, forOrg } from "@repo/database";
import { collectSources, type Source } from "./citations";
import { CONTEXT_PART, type ContextUse } from "./history";

export const MAX_MESSAGE_CHARS = 4000;
/** Messages per user per minute. */
export const RATE_LIMIT = 8;

export interface ConversationSummary {
  id: string;
  messages: number;
  title: string;
  updatedAt: Date;
}

export const titleFrom = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80
    ? `${line.slice(0, 77)}…`
    : line || "New conversation";
};

export const messageText = (message: Pick<UIMessage, "parts">) =>
  message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();

/** Tool parts in a message, as { tool, input, output, error }. */
export const toolParts = (message: Pick<UIMessage, "parts">) =>
  message.parts.flatMap((part) => {
    if (!part.type.startsWith("tool-")) {
      return [];
    }
    const p = part as {
      errorText?: string;
      input?: unknown;
      output?: unknown;
      state?: string;
      type: string;
    };
    return [
      {
        tool: p.type.slice("tool-".length),
        input: p.input,
        output: p.output,
        error: p.errorText ?? null,
      },
    ];
  });

/** Sources the tools in these messages returned, for checking citations. */
export const sourcesIn = (messages: Pick<UIMessage, "parts">[]): Source[] => [
  ...collectSources(
    messages.flatMap((m) => toolParts(m).map((t) => t.output))
  ).values(),
];

/** The user's conversation, or null if it isn't theirs. */
export const findConversation = (orgId: string, userId: string, id: string) =>
  forOrg(database, orgId).conversation.findFirst({
    where: { id, userId },
    select: { id: true, title: true },
  });

export const loadMessages = async (
  conversationId: string
): Promise<UIMessage[]> => {
  const rows = await database.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, parts: true },
  });
  return rows.map((row) => {
    const parts = Array.isArray(row.parts)
      ? (row.parts as UIMessage["parts"])
      : [{ type: "text" as const, text: row.content }];
    // The context the answer used is stored as a hidden part: hand it back
    // as metadata, the way the live stream delivers it.
    const saved = parts.find((p) => p.type === CONTEXT_PART) as
      | { data: ContextUse }
      | undefined;
    return {
      id: row.id,
      role: row.role === "assistant" ? "assistant" : "user",
      parts: parts.filter((p) => p.type !== CONTEXT_PART),
      ...(saved ? { metadata: { context: saved.data } } : {}),
    };
  });
};

export const listConversations = async (
  orgId: string,
  userId: string,
  take = 50
): Promise<ConversationSummary[]> => {
  const rows = await forOrg(database, orgId).conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  return rows
    .filter((r) => r._count.messages > 0)
    .map((r) => ({
      id: r.id,
      title: r.title ?? "Conversation",
      updatedAt: r.updatedAt,
      messages: r._count.messages,
    }));
};

/** How many messages this user sent in the last minute (across conversations). */
export const recentUserMessages = (orgId: string, userId: string) =>
  database.message.count({
    where: {
      role: "user",
      createdAt: { gte: new Date(Date.now() - 60_000) },
      conversation: { orgId, userId },
    },
  });
