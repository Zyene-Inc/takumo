// The words of an answer by email (docs/PRODUCT-PLAN.md F3.4): what Takumo
// replies, in the same thread, to a question sent to the shop's ask-…@
// address. Pure, so tested; lib/inbound/ask.ts runs the question.

/** How Takumo is told to answer by email, on top of Ask Takumo's prompt. */
export const EMAIL_INSTRUCTIONS = `
This question came by email to the shop's Takumo address, usually a customer's request forwarded by someone in sales. Your answer is emailed back to them in the same thread.
- If the part, the quantity or the date is missing or unclear, don't guess and don't run a check: reply with exactly one short question asking for what's missing, and nothing else.
- Otherwise run check_capacity and answer in this order, each as a short paragraph starting with its label:
  Answer: yes or no, and the earliest date without moving other orders.
  Why: the machines, the people on shift and the material behind that date, each with where it comes from.
  If it goes first: which orders would slip and by how much (only if it doesn't fit as it is).
  Ways to make it: overtime, another qualified operator, an alternate machine, splitting the lot or expediting the material, with the cost where known (only if it doesn't fit as it is).
- Plain text for an email: no tables, no markdown headings, no citation brackets, no follow-up questions block.`;

const RE = /^\s*re\s*:/i;

/** "Re: <subject>", once. */
export const replySubject = (subject: string | null) => {
  const s = (subject ?? "").trim();
  if (!s) {
    return "Re: your question";
  }
  return RE.test(s) ? s : `Re: ${s}`;
};

/** Citation brackets like [check NEW-261104-1] read badly in an email. */
const CITATION = /\s?\[(?:check|query|order|part|plan|doc|fact|scenario|estimate)[^\]]*\]/gi;

/** The email body: the answer, the add-to-plan link, the conversation. */
export const answerEmail = (input: {
  answer: string;
  /** Absolute links that open a check with "Add to plan". */
  addToPlan: string[];
  conversationUrl: string;
}) => {
  const answer = input.answer.replace(CITATION, "").trim();
  const lines = [answer, ""];
  const [link] = input.addToPlan;
  if (link) {
    lines.push(
      `Add it to the plan (Takumo's plan only; nothing is written to your ERP): ${link}`
    );
  }
  lines.push(`The whole answer, with its sources: ${input.conversationUrl}`);
  return lines.join("\n");
};

/** In-Reply-To and References, so the reply lands in the sender's thread. */
export const threadHeaders = (
  headers: ReadonlyMap<string, string>
): Record<string, string> => {
  const messageId = headers.get("message-id")?.trim();
  if (!messageId) {
    return {};
  }
  const references = headers.get("references")?.trim();
  return {
    "In-Reply-To": messageId,
    References: references ? `${references} ${messageId}` : messageId,
  };
};
