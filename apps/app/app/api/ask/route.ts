import { convertToModelMessages, streamText, type UIMessage } from "@repo/ai";
import { auth } from "@repo/auth/server";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { agentSettings } from "@/lib/agent/agent";
import {
  findConversation,
  loadMessages,
  MAX_MESSAGE_CHARS,
  messageText,
  RATE_LIMIT,
  recentUserMessages,
  sourcesIn,
  titleFrom,
  toolParts,
} from "@/lib/agent/conversations";
import { checkToday } from "@/lib/schedule/request";

// Several tool calls (and a capacity check) per answer.
export const maxDuration = 300;

const Body = z.object({
  id: z.uuid(),
  message: z.object({
    id: z.string().min(1).max(100),
    role: z.literal("user"),
    parts: z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .min(1),
  }),
  today: z.string(),
});

const problem = (status: number, error: string) =>
  Response.json({ error }, { status });

/**
 * Ask Takumo. The browser sends only the new user message; history, tool
 * results and citations come from the database, so a client can't put words
 * in the assistant's mouth.
 */
export const POST = async (request: Request) => {
  const { orgId, userId } = await auth();
  if (!(orgId && userId)) {
    return problem(401, "Sign in and choose a shop first.");
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return problem(400, "That message couldn't be read. Reload and try again.");
  }
  const { id, message, today: localDay } = parsed.data;
  const today = checkToday(localDay);
  if (!today) {
    return problem(
      400,
      "Your computer's date looks wrong; reload and try again."
    );
  }
  const text = messageText(message);
  if (!text) {
    return problem(400, "Type a question first.");
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return problem(
      400,
      `Keep questions under ${MAX_MESSAGE_CHARS.toLocaleString()} characters.`
    );
  }
  if ((await recentUserMessages(orgId, userId)) >= RATE_LIMIT) {
    return problem(
      429,
      "That's a lot of questions at once. Wait a minute and try again."
    );
  }

  // The conversation must be this user's (or new).
  const existing = await findConversation(orgId, userId, id);
  if (!existing) {
    const taken = await database.conversation.findUnique({
      where: { id },
      select: { id: true },
    });
    if (taken) {
      return problem(404, "Conversation not found.");
    }
    await database.conversation.create({
      data: { id, orgId, userId, title: titleFrom(text) },
    });
  }

  // Retrying a question replaces its old answer.
  let history = await loadMessages(id);
  const retryAt = history.findIndex((m) => m.id === message.id);
  if (retryAt >= 0) {
    await database.message.deleteMany({
      where: {
        conversationId: id,
        id: { in: history.slice(retryAt).map((m) => m.id) },
      },
    });
    history = history.slice(0, retryAt);
  }
  const userMessage: UIMessage = {
    id: message.id,
    role: "user",
    parts: message.parts,
  };
  await database.message.create({
    data: {
      id: message.id,
      conversationId: id,
      role: "user",
      content: text,
      parts: userMessage.parts as object,
    },
  });

  const prior = toolParts({ parts: history.flatMap((m) => m.parts) });
  const settings = await agentSettings(
    { orgId, userId, today },
    {
      queries: prior.filter((t) => t.tool === "query_data").length,
      scenarios: prior.filter((t) => t.tool === "run_scenario").length,
      estimates: prior.filter((t) => t.tool === "estimate_quote").length,
    }
  );
  const messages = [...history, userMessage];
  const result = streamText({
    ...settings,
    messages: await convertToModelMessages(messages, { tools: settings.tools }),
    onError: ({ error }) =>
      log.error("Ask Takumo failed", { error: String(error) }),
  });
  // Finish (and save) the answer even if the browser goes away.
  result.consumeStream();

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    generateMessageId: () => crypto.randomUUID(),
    onError: () =>
      "Takumo hit a problem answering that. Try again in a moment.",
    onFinish: async ({ responseMessage }) => {
      const tools = toolParts(responseMessage);
      await database.message.create({
        data: {
          id: responseMessage.id,
          conversationId: id,
          role: "assistant",
          content: messageText(responseMessage),
          parts: responseMessage.parts as object,
          // Audit trail of what the agent looked at.
          toolCalls: tools.map((t) => ({
            tool: t.tool,
            input: t.input,
            error: t.error,
          })) as object,
          citations: sourcesIn([responseMessage]) as object,
        },
      });
      await database.conversation.update({
        where: { id },
        data: { updatedAt: new Date() },
      });
    },
  });
};
