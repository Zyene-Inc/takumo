import "server-only";

import { generateText } from "@repo/ai";
import { listShopMembers } from "@repo/auth/server";
import { database, forOrg, Prisma } from "@repo/database";
import { resend } from "@repo/email";
import { keys as emailKeys } from "@repo/email/keys";
import { log } from "@repo/observability/log";
import { env } from "@/env";
import { agentSettings } from "../agent/agent";
import { splitAnswer } from "../agent/answer";
import { MAX_MESSAGE_CHARS, titleFrom } from "../agent/conversations";
import { HIDDEN_ANSWER, stillAllowed } from "../agent/redact";
import { agentContext } from "../agent/tools";
import { budgetProblem, recordUsage } from "../ai-usage";
import { track } from "../analytics";
import { featureProblem } from "../billing";
import {
  answerProvenance,
  linkProposedFacts,
  recordAnswerSources,
  removedAnswer,
  settleSources,
} from "../library/provenance";
import { viewerForMember } from "../library/viewer";
import { parseEmail } from "../quotes/email";
import {
  answerEmail,
  EMAIL_INSTRUCTIONS,
  replySubject,
  threadHeaders,
} from "./ask-email";

// "Can we ship 300 by Friday?" by email (docs/PRODUCT-PLAN.md F3.4): someone
// in the shop forwards or writes a question to its ask-…@ address; Takumo
// answers from the plan with Ask Takumo's tools, replies in the same thread,
// and keeps the conversation in Ask Takumo history.

/** The shop's members' addresses, lower-cased: who may use the address. */
export const memberAddresses = async (orgId: string) =>
  (await listShopMembers(orgId))
    .map((m) => m.email?.toLowerCase())
    .filter((e): e is string => Boolean(e));

const today = () => new Date().toISOString().slice(0, 10);

const finish = (
  orgId: string,
  messageId: string,
  status: string,
  detail: object
) =>
  forOrg(database, orgId).inboundMessage.updateMany({
    where: { id: messageId },
    data: { status, detail },
  });

/** Links the check tool returned, made absolute (open it with Add to plan). */
const addToPlanLinks = (
  steps: { toolResults: { output: unknown; toolName: string }[] }[]
) =>
  steps
    .flatMap((s) => s.toolResults)
    .filter((r) => r.toolName === "check_capacity")
    .map((r) => (r.output as { add_to_plan_link?: string }).add_to_plan_link)
    .filter((l): l is string => Boolean(l))
    .map((l) => `${env.NEXT_PUBLIC_APP_URL}${l}`);

const send = async (
  to: string,
  subject: string,
  text: string,
  headers: Record<string, string>
) => {
  const from = emailKeys().RESEND_FROM;
  if (!(resend && from)) {
    return false;
  }
  await resend.emails.send({ from, to, subject, text, headers });
  return true;
};

/** Answer one question sent to the ask address; never throws. */
export const processAsk = async (
  orgId: string,
  messageId: string,
  raw: Uint8Array
) => {
  const email = parseEmail(new TextDecoder().decode(raw));
  // Who sent it, as checked when it arrived (receiveMessage: the From header
  // as sent, its domain authenticated), never re-read from the decoded
  // header (security audit M3).
  const sender =
    (
      await database.inboundMessage.findFirst({
        where: { id: messageId, orgId },
        select: { fromAddress: true },
      })
    )?.fromAddress ?? null;
  const subject = replySubject(email.subject);
  const headers = threadHeaders(email.headers);
  try {
    const member = (await listShopMembers(orgId)).find(
      (m) => m.email?.toLowerCase() === sender
    );
    // The answer reads documents and facts as this member, with their role
    // read from WorkOS now (never from the email).
    const viewer =
      member && sender ? await viewerForMember(orgId, member.userId) : null;
    if (!(member && sender && viewer)) {
      await finish(orgId, messageId, "rejected", {
        error: "Only people in the shop can ask by email.",
      });
      return;
    }
    const blocked =
      (await featureProblem(orgId, "ask")) ?? (await budgetProblem(orgId));
    if (blocked) {
      await send(sender, subject, blocked, headers);
      await finish(orgId, messageId, "failed", { error: blocked });
      return;
    }
    const question = [email.subject, email.body]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, MAX_MESSAGE_CHARS);
    const conversation = await database.conversation.create({
      data: {
        orgId,
        userId: member.userId,
        title: titleFrom(email.subject || email.body),
      },
    });
    await database.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: question,
        parts: [{ type: "text", text: question }],
        provenance: "recorded",
      },
    });

    const settings = await agentSettings(
      agentContext(viewer, today()),
      undefined,
      "thorough"
    );
    const result = await generateText({
      ...settings,
      instructions: `${settings.instructions}\n${EMAIL_INSTRUCTIONS}`,
      prompt: question,
      onStepEnd: ({ usage, response }) =>
        recordUsage(orgId, "ask", response.modelId, usage, member.userId),
    });
    const worked = await answerProvenance(
      orgId,
      conversation.id,
      result.steps.flatMap((s) =>
        s.toolResults.map((r) => ({
          tool: r.toolName,
          input: r.input,
          output: r.output,
        }))
      )
    );
    // Access may have changed while answering: an answer they may no
    // longer see is neither kept nor emailed.
    const now = await viewerForMember(orgId, member.userId);
    const allowed = Boolean(
      now && (await stillAllowed(now, worked.documentIds))
    );
    const answer = allowed
      ? splitAnswer(result.text).body.trim()
      : HIDDEN_ANSWER;
    const links = allowed ? addToPlanLinks(result.steps) : [];
    const tools = result.steps.flatMap((s) => s.toolCalls);
    // Which documents the answer drew on, saved with it (MessageSource).
    const used = result.steps.flatMap((s) =>
      s.toolResults.map((r) => ({
        tool: r.toolName,
        input: r.input,
        output: r.output,
      }))
    );
    await database.$transaction(async (tx) => {
      const found = await settleSources(tx, orgId, worked);
      const saved = await tx.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          content: answer,
          parts: [{ type: "text", text: answer }],
          toolCalls: allowed
            ? (tools.map((t) => ({
                tool: t.toolName,
                input: t.input,
              })) as object)
            : Prisma.DbNull,
          provenance: found.provenance,
          // A document it used was permanently deleted meanwhile.
          ...(found.gone ? removedAnswer() : {}),
        },
        select: { id: true },
      });
      await recordAnswerSources(tx, orgId, conversation.id, saved.id, found);
      await linkProposedFacts(tx, orgId, used, found);
    });
    const emailed = await send(
      sender,
      subject,
      answerEmail({
        answer,
        addToPlan: links,
        conversationUrl: `${env.NEXT_PUBLIC_APP_URL}/ask?c=${conversation.id}`,
      }),
      headers
    );
    if (!emailed) {
      log.info("Ask-by-email answer not emailed (no email service)", {
        orgId,
      });
    }
    await finish(orgId, messageId, "processed", {
      answered: true,
      emailed,
      conversation: conversation.id,
    });
    track("question_answered", {
      orgId,
      userId: member.userId,
      properties: {
        channel: "email",
        tools: tools.map((t) => t.toolName),
      },
    });
  } catch (error) {
    log.error("Answering a question by email failed", {
      orgId,
      error: String(error),
    });
    await finish(orgId, messageId, "failed", {
      error: "Takumo couldn't answer this one. It's been logged.",
    });
    if (sender) {
      await send(
        sender,
        subject,
        "Takumo couldn't answer this one just now. Try again in a few minutes, or ask in Ask Takumo.",
        headers
      ).catch(() => undefined);
    }
  }
};
