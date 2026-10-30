// The email that goes with an approved quote. Pure.

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

const firstName = (contact: string | null) => {
  const name = contact?.split(NAME_END)[0]?.trim();
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
