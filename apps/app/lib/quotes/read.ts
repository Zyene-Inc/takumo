// The text of an RFQ, from an uploaded file or a pasted email. No database or
// model calls, so tested on fixtures.

import { extractPages } from "../knowledge/extract";
import { parseEmail } from "./email";
import { RFQ_TYPES, type RfqSource } from "./types";

export interface RfqText {
  body: string;
  sender: string | null;
  source: RfqSource;
  subject: string | null;
}

/** Characters of RFQ text sent to the model; real RFQs are far shorter. */
export const MAX_RFQ_CHARS = 60_000;

const extension = (name: string) =>
  name.slice(name.lastIndexOf(".")).toLowerCase();

const ATTACHMENT_TYPES = [".pdf", ".docx", ".txt", ".md"];
const SUBJECT_LINE = /^subject:\s*(.+)$/im;
const FROM_LINE = /^from:\s*(.+)$/im;

const pagesText = (pages: { page: number | null; text: string }[]) =>
  pages
    .map((p) =>
      pages.length > 1 && p.page
        ? `[Page ${p.page}]\n${p.text.trim()}`
        : p.text.trim()
    )
    .filter(Boolean)
    .join("\n\n");

const clip = (text: string) =>
  text.length > MAX_RFQ_CHARS ? text.slice(0, MAX_RFQ_CHARS) : text;

/** A pasted email: picks up "Subject:" and "From:" lines when they're there. */
export const readPasted = (text: string): RfqText => {
  const header = text.slice(0, 2000);
  const subject = header.match(SUBJECT_LINE)?.[1]?.trim() ?? null;
  const sender = header.match(FROM_LINE)?.[1]?.trim() ?? null;
  return {
    source: subject || sender ? "email" : "paste",
    subject,
    sender,
    body: clip(text.trim()),
  };
};

export const readRfqFile = async (
  name: string,
  bytes: Uint8Array
): Promise<RfqText> => {
  const ext = extension(name);
  if (!(RFQ_TYPES as readonly string[]).includes(ext)) {
    throw new Error(`Takumo reads RFQs as ${RFQ_TYPES.join(", ")} files.`);
  }
  if (ext === ".eml") {
    const email = parseEmail(new TextDecoder().decode(bytes));
    const parts = [email.body];
    for (const attachment of email.attachments) {
      if (!ATTACHMENT_TYPES.includes(extension(attachment.name))) {
        continue;
      }
      try {
        const text = pagesText(
          await extractPages(attachment.name, attachment.bytes)
        );
        if (text) {
          parts.push(`--- Attachment: ${attachment.name} ---\n${text}`);
        }
      } catch {
        parts.push(`--- Attachment: ${attachment.name} (couldn't be read) ---`);
      }
    }
    return {
      source: "email",
      subject: email.subject,
      sender: email.from,
      body: clip(parts.filter(Boolean).join("\n\n")),
    };
  }
  const text = pagesText(await extractPages(name, bytes));
  if (ext === ".txt" || ext === ".md") {
    return { ...readPasted(text), source: "upload" };
  }
  return { source: "upload", subject: null, sender: null, body: clip(text) };
};
