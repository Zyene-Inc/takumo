import "server-only";

import { generateText } from "@repo/ai";
import { listShopMembers } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { resend } from "@repo/email";
import { keys as emailKeys } from "@repo/email/keys";
import { log } from "@repo/observability/log";
import { env } from "@/env";
import { agentSettings } from "../agent/agent";
import { splitAnswer } from "../agent/answer";
import { MAX_MESSAGE_CHARS, titleFrom } from "../agent/conversations";
import { budgetProblem, recordUsage } from "../ai-usage";
import { track } from "../analytics";
import { featureProblem } from "../billing";
import { parseEmail } from "../quotes/email";
import {
  answerEmail,
  EMAIL_INSTRUCTIONS,
  replySubject,
  threadHeaders,
} from "./ask-email";
import { emailAddress } from "./verify";

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
  const sender = emailAddress(email.from);
  const subject = replySubject(email.subject);
  const headers = threadHeaders(email.headers);
  try {
    const member = (await listShopMembers(orgId)).find(
      (m) => m.email?.toLowerCase() === sender
    );
    if (!(member && sender)) {
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
      },
    });

    const settings = await agentSettings(
      { orgId, userId: member.userId, today: today() },
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
    const answer = splitAnswer(result.text).body.trim();
    const links = addToPlanLinks(result.steps);
    const tools = result.steps.flatMap((s) => s.toolCalls);
    await database.message.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: answer,
        parts: [{ type: "text", text: answer }],
        toolCalls: tools.map((t) => ({
          tool: t.toolName,
          input: t.input,
        })) as object,
      },
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
