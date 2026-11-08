import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "@repo/ai";
import { database, Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { agentSettings } from "@/lib/agent/agent";
import { type AnswerMode, ASK_MODES, splitAnswer } from "@/lib/agent/answer";
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
import {
  CONTEXT_PART,
  type ContextUse,
  compactHistory,
} from "@/lib/agent/history";
import { chooseMode } from "@/lib/agent/mode";
import {
  documentsToRecheck,
  HIDDEN_ANSWER,
  redactHistory,
  stillAllowed,
} from "@/lib/agent/redact";
import { agentContext } from "@/lib/agent/tools";
import { recordUsage } from "@/lib/ai-usage";
import { track } from "@/lib/analytics";
import { featureProblem } from "@/lib/billing";
import { usableSourceIds } from "@/lib/library/ai-access";
import {
  answerProvenance,
  linkProposedFacts,
  recordAnswerSources,
  removedAnswer,
  settleSources,
} from "@/lib/library/provenance";
import { resolveViewer, viewerForMember } from "@/lib/library/viewer";
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
  mode: z.enum(ASK_MODES).default("auto"),
});

const problem = (status: number, error: string) =>
  Response.json({ error }, { status });

/** What an answer is saved as when its asker can't use what it drew on any more. */
const hiddenAnswer = () => ({
  content: HIDDEN_ANSWER,
  parts: [{ type: "text", text: HIDDEN_ANSWER }],
  citations: Prisma.DbNull,
  toolCalls: Prisma.DbNull,
});

/**
 * Ask Takumo. The browser sends only the new user message; history, tool
 * results and citations come from the database, so a client can't put words
 * in the assistant's mouth. Everything is read as the signed-in person: the
 * tools see only the documents and facts they may use, and earlier answers
 * that drew on anything they can't use now are hidden, from the screen and
 * from the model.
 */
export const POST = async (request: Request) => {
  const viewer = await resolveViewer();
  if (!(viewer?.userId && !viewer.isSystem)) {
    return problem(401, "Sign in and choose a shop first.");
  }
  const { orgId, userId } = viewer;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return problem(400, "That message couldn't be read. Reload and try again.");
  }
  const { id, message, today: localDay, mode: asked } = parsed.data;
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
  const locked = await featureProblem(orgId, "ask");
  if (locked) {
    return problem(402, locked);
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

  // Retrying a question replaces its old answer. Answers that drew on
  // documents this person can't use now never reach the model again.
  const [loaded, usableWhenAsked] = await Promise.all([
    loadMessages(id),
    usableSourceIds(viewer, "search"),
  ]);
  let history = await redactHistory(viewer, id, loaded);
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
      provenance: "recorded",
    },
  });

  const prior = toolParts({ parts: history.flatMap((m) => m.parts) });
  const lastAnswer = [...history].reverse().find((m) => m.role === "assistant");
  const mode: AnswerMode =
    asked === "auto"
      ? await chooseMode(
          orgId,
          userId,
          text,
          lastAnswer && splitAnswer(messageText(lastAnswer)).body
        )
      : asked;
  const settings = await agentSettings(
    agentContext(viewer, today),
    {
      queries: prior.filter((t) => t.tool === "query_data").length,
      scenarios: prior.filter((t) => t.tool === "run_scenario").length,
      estimates: prior.filter((t) => t.tool === "estimate_quote").length,
    },
    mode
  );
  const messages = [...history, userMessage];
  let context: ContextUse | null = null;
  const result = streamText({
    ...settings,
    messages: await convertToModelMessages(compactHistory(messages), {
      tools: settings.tools,
    }),
    onError: ({ error }) =>
      log.error("Ask Takumo failed", { error: String(error) }),
    // Each step as it finishes (cache reads and writes included), so the
    // steps before an error are still counted.
    onStepEnd: ({ usage, response }) => {
      // The last step saw the most: everything the answer looked at.
      context = { model: response.modelId, tokens: usage.inputTokens ?? 0 };
      return recordUsage(orgId, "ask", response.modelId, usage, userId);
    },
  });
  // Finish the model's work (and record its usage) even if the browser goes
  // away; saving the answer is kept going by consumeSseStream below.
  result.consumeStream();

  const stream = toUIMessageStream({
    stream: result.stream,
    tools: settings.tools,
    originalMessages: messages,
    generateMessageId: () => crypto.randomUUID(),
    // The chat shows which model answered, and offers a thorough re-run.
    // and how much context the answer used (the composer's ring).
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        return { mode };
      }
      return part.type === "finish" ? { mode, context } : undefined;
    },
    onError: () =>
      "Takumo hit a problem answering that. Try again in a moment.",
    onEnd: async ({ responseMessage }) => {
      const tools = toolParts(responseMessage);
      track("question_answered", {
        orgId,
        userId,
        properties: { tools: tools.map((t) => t.tool), mode, asked },
      });
      // Which documents the answer drew on, saved with it (MessageSource).
      const worked = await answerProvenance(orgId, id, tools);
      // Access may have changed while the model was answering: what was
      // streamed can't be taken back, but an answer the person may no
      // longer see isn't kept (and so never reaches the model again).
      const now = await viewerForMember(orgId, userId);
      const allowed = Boolean(
        now &&
          (await stillAllowed(
            now,
            documentsToRecheck(worked.rows, usableWhenAsked)
          ))
      );
      await database.$transaction(async (tx) => {
        const found = await settleSources(tx, orgId, worked);
        await tx.message.create({
          data: {
            id: responseMessage.id,
            conversationId: id,
            role: "assistant",
            content: splitAnswer(messageText(responseMessage)).body,
            parts: (context
              ? [
                  ...responseMessage.parts,
                  { type: CONTEXT_PART, data: context },
                ]
              : responseMessage.parts) as object,
            // Audit trail of what the agent looked at.
            toolCalls: tools.map((t) => ({
              tool: t.tool,
              input: t.input,
              error: t.error,
            })) as object,
            citations: sourcesIn([responseMessage]) as object,
            provenance: found.provenance,
            ...(allowed ? {} : hiddenAnswer()),
            // A document it used was permanently deleted meanwhile.
            ...(found.gone ? removedAnswer() : {}),
          },
        });
        await recordAnswerSources(tx, orgId, id, responseMessage.id, found);
        await linkProposedFacts(tx, orgId, tools, found);
      });
      await database.conversation.update({
        where: { id },
        data: { updatedAt: new Date() },
      });
    },
  });
  return createUIMessageStreamResponse({
    stream,
    // A copy of the stream is read to the end on the server, so the answer
    // is finished and saved (onEnd) even when the browser goes away; without
    // it the saved answer was empty (__tests__/ask-stream.test.ts).
    consumeSseStream: consumeStream,
  });
};
