// The email that goes with a quote. Pure.

import type { SentPrice } from "./types";

export interface ReplyLine {
  breaks: { leadTimeDays: number; qty: number; unitPrice: number }[];
  partNo: string;
  quoteNo: string;
  rev: string | null;
}

const NAME_END = /[<(,@]/;
const SPACES = /\s+/;
const PLAIN_NAME = /^[A-Za-z][A-Za-z'-]*$/;
const REPLY_PREFIX = /^(re|fw|fwd):\s*/i;

const money = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const BARE_ADDRESS = /^\s*[^\s<>]+@/;

const firstName = (contact: string | null) => {
  // "purchasing@x.com" has no name in it.
  if (!contact || BARE_ADDRESS.test(contact)) {
    return null;
  }
  const name = contact.split(NAME_END)[0]?.trim();
  const first = name?.split(SPACES)[0];
  return first && PLAIN_NAME.test(first) ? first : null;
};

export const replyEmail = (input: {
  contact: string | null;
  lines: ReplyLine[];
  reference: string;
  shop: string;
  subject: string | null;
}) => {
  const hello = firstName(input.contact);
  const body = input.lines
    .map((line) => {
      const part = `${line.partNo}${line.rev ? ` rev ${line.rev}` : ""}`;
      const prices = line.breaks
        .map(
          (b) =>
            `  - ${b.qty.toLocaleString("en-US")} pcs: ${money(b.unitPrice)}/ea, ${b.leadTimeDays} days`
        )
        .join("\n");
      return `${part} (${line.quoteNo})\n${prices}`;
    })
    .join("\n\n");
  return {
    subject: `Quote ${input.reference}${input.subject ? ` – ${input.subject.replace(REPLY_PREFIX, "")}` : ""}`,
    body: `${hello ? `Hi ${hello},` : "Hello,"}

Thanks for the opportunity to quote. Our pricing is below and in the attached quote ${input.reference}.

${body}

Lead times are calendar days from order. Let us know if you have any questions.

Best regards,
${input.shop}`,
  };
};

// ---------------------------------------------------------------------------
// The draft reply left in the customer's thread (docs/PRODUCT-PLAN.md F2.5).
// Customer-facing only: no costs, margins, flags, internal notes or links
// back into Takumo ever go in here (R3).
// ---------------------------------------------------------------------------

export interface DraftReplyLine extends ReplyLine {
  finish: string | null;
  material: string | null;
  /** Questions about this part (e.g. from its drawing). */
  questions: string[];
  tolerances: string | null;
}

export interface DraftReplyInput {
  contact: string | null;
  /** The shop's own opening line, replacing the default. */
  intro: string | null;
  lines: DraftReplyLine[];
  /** Whether the quote PDF is attached. */
  pdf: boolean;
  /** Questions about the RFQ as a whole. */
  questions: string[];
  reference: string;
  shop: string;
  /** The shop's signature, replacing "Best regards, <shop>". */
  signature: string | null;
  subject: string | null;
  validityDays: number;
}

const MAX_QUESTIONS = 8;

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const partLabel = (line: ReplyLine) =>
  `${line.partNo}${line.rev ? ` rev ${line.rev}` : ""}`;

const breakLine = (b: ReplyLine["breaks"][number]) =>
  `${b.qty.toLocaleString("en-US")} pcs: ${money(b.unitPrice)}/ea, ${money(Math.round(b.unitPrice * b.qty * 100) / 100)} total, ${b.leadTimeDays} days`;

const assumption = (line: DraftReplyLine) => {
  const parts = [
    line.material ? `material ${line.material}` : null,
    line.finish ? `finish ${line.finish}` : null,
    line.tolerances ? `tolerances ${line.tolerances}` : null,
  ].filter(Boolean);
  return parts.length ? `${partLabel(line)}: ${parts.join("; ")}` : null;
};

const unique = (items: string[]) => [
  ...new Set(items.map((q) => q.trim()).filter(Boolean)),
];

/** The blocks of the draft, in order: each a paragraph or a list. */
const draftBlocks = (input: DraftReplyInput) => {
  const hello = firstName(input.contact);
  const blocks: ({ text: string } | { items: string[]; title: string })[] = [
    { text: hello ? `Hi ${hello},` : "Hello," },
    {
      text:
        input.intro?.trim() ||
        `Thanks for the opportunity to quote. Our pricing is below${input.pdf ? ` and in the attached quote ${input.reference}` : ""}.`,
    },
  ];
  for (const line of input.lines) {
    blocks.push({
      title: `${partLabel(line)} (${line.quoteNo})`,
      items: line.breaks.map(breakLine),
    });
  }
  const assumptions = input.lines
    .map(assumption)
    .filter((a): a is string => a !== null);
  if (assumptions.length) {
    blocks.push({ title: "Quoted as", items: assumptions });
  }
  const questions = unique([
    ...input.questions,
    ...input.lines.flatMap((l) =>
      l.questions.map((q) =>
        input.lines.length > 1 ? `${partLabel(l)}: ${q}` : q
      )
    ),
  ]).slice(0, MAX_QUESTIONS);
  if (questions.length) {
    blocks.push({ title: "A few questions", items: questions });
  }
  blocks.push({
    text: `Prices are valid for ${input.validityDays} days. Lead times are calendar days from order.`,
  });
  blocks.push({
    text: input.signature?.trim() || `Best regards,\n${input.shop}`,
  });
  return blocks;
};

const SUBJECT_PREFIX = /^(re|fw|fwd):\s*/i;

/** Subject, plain text and HTML of the draft reply. Pure. */
export const draftReply = (input: DraftReplyInput) => {
  const blocks = draftBlocks(input);
  const text = blocks
    .map((b) =>
      "text" in b
        ? b.text
        : `${b.title}\n${b.items.map((i) => `  - ${i}`).join("\n")}`
    )
    .join("\n\n");
  const html = blocks
    .map((b) =>
      "text" in b
        ? `<p>${escapeHtml(b.text).replaceAll("\n", "<br>")}</p>`
        : `<p>${escapeHtml(b.title)}</p><ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
    )
    .join("");
  const original = input.subject?.replace(SUBJECT_PREFIX, "").trim();
  return {
    subject: `Quote ${input.reference}${original ? ` - ${original}` : ""}`,
    text,
    html: `<div>${html}</div>`,
  };
};

const ENTITY = /&#(x?[0-9a-f]+);/gi;
const ANY_SPACE = /[\s ​]+/g;

/**
 * Text compared to tell whether the estimator edited the draft: entities
 * decoded, all spacing collapsed (mail apps reflow HTML freely).
 */
export const normalizeBody = (text: string) =>
  text
    .replace(ENTITY, (_, code: string) =>
      String.fromCodePoint(
        code[0].toLowerCase() === "x"
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10)
      )
    )
    .replace(ANY_SPACE, " ")
    .trim();

/**
 * Whether the draft in the mailbox still holds Takumo's text unchanged (the
 * quoted original below it doesn't count).
 */
export const draftUntouched = (mailboxText: string, ours: string) =>
  ours.length > 0 && normalizeBody(mailboxText).includes(ours);

// "100 pcs: $12.50/ea" and the forms estimators edit it into:
// "100 @ $12.50", "Qty 100 - $12.50 each", "100 pieces $1,250.00 ea".
const BREAK =
  /(?:qty\.?\s*)?(\d[\d,]*)\s*(?:pcs|pc|pieces|parts|units|ea)?\s*(?:[:@=-]|at)?\s*\$\s*(\d[\d,]*(?:\.\d+)?)\s*(?:\/\s*(?:ea|each|pc|piece)|each|ea)?/i;
const LEAD =
  /(\d+)\s*(?:calendar\s+|working\s+|business\s+)?(days?|weeks?|wks?)/i;

const QUOTED_START = /^(on .+ wrote:|from:\s|-+\s*original message)/i;

const number = (text: string) => Number(text.replaceAll(",", ""));

const leadDays = (line: string, after: number) => {
  const match = line.slice(after).match(LEAD);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  return match[2].toLowerCase().startsWith("w") ? n * 7 : n;
};

/**
 * The prices in a reply the estimator sent, per part: each line that names a
 * quantity and a $ price, under the last part number mentioned above it.
 * Parts are matched to the RFQ's own part numbers, so stray numbers in the
 * quoted original aren't read as prices.
 */
export const parseSentPrices = (
  text: string,
  partNos: string[]
): SentPrice[] => {
  const known = partNos.filter(Boolean);
  const prices: SentPrice[] = [];
  let part: string | null = known.length === 1 ? known[0] : null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // The quoted original starts here: stop reading.
    if (line.startsWith(">") || QUOTED_START.test(line)) {
      break;
    }
    const named = known
      .filter((p) => line.toLowerCase().includes(p.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
    if (named) {
      part = named;
    }
    const match = line.match(BREAK);
    if (!(match && part) || match.index === undefined) {
      continue;
    }
    const qty = number(match[1]);
    const unitPrice = number(match[2]);
    if (!(qty > 0 && unitPrice > 0)) {
      continue;
    }
    if (prices.some((p) => p.partNo === part && p.qty === qty)) {
      continue;
    }
    prices.push({
      partNo: part,
      qty,
      unitPrice,
      leadTimeDays: leadDays(line, match.index + match[0].length),
    });
  }
  return prices;
};

export type DraftStep = "create" | "replace" | "add" | "unchanged" | "skip";

/**
 * What to do with the mailbox when the RFQ's draft reply is written again
 * (F2.5-R4). `current` is the draft's text in the mailbox now: null when it
 * was deleted or sent. Automatic runs never bring back a deleted draft; the
 * estimator's button does. An edited draft is never overwritten.
 */
export const draftStep = (input: {
  /** Text Takumo wrote last time (normalized), if there's a draft. */
  before: string | null;
  current: string | null;
  mode: "auto" | "explicit";
  /** Normalized text of the new draft. */
  next: string;
}): DraftStep => {
  if (input.before === null) {
    return "create";
  }
  if (input.current === null) {
    return input.mode === "auto" ? "skip" : "create";
  }
  if (!draftUntouched(input.current, input.before)) {
    return "add";
  }
  return input.before === input.next ? "unchanged" : "replace";
};
