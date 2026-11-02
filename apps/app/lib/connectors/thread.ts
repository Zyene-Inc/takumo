// Which email conversation an RFQ came from, kept on the RFQ so a reply draft
// can go into the same thread (F2.5) and so the same RFQ arriving again in a
// reply chain isn't read twice. Pure, so tested without a mailbox.

import { createHash } from "node:crypto";
import { parseEmail } from "../quotes/email";

/** Kept on `Rfq.extracted.mail`; the reading of the RFQ sits beside it. */
export interface MailThread {
  /** Fingerprint of the attachments ("none" when there aren't any). */
  attachmentsHash: string;
  provider: "gmail" | "outlook";
  /** Gmail's threadId or Outlook's conversationId. */
  threadId: string | null;
}

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * The same files give the same fingerprint whatever order they come in or
 * what they're called, so a forwarded or re-sent RFQ matches the original.
 */
export const attachmentsHashOf = (files: { bytes: Uint8Array }[]) => {
  if (files.length === 0) {
    return "none";
  }
  return sha256(
    files
      .map((f) => sha256(f.bytes))
      .sort()
      .join(",")
  );
};

/** A raw message's sender and attachment fingerprint, read once. */
export const fingerprint = (raw: Uint8Array) => {
  const email = parseEmail(new TextDecoder().decode(raw));
  return {
    from: email.from,
    attachmentsHash: attachmentsHashOf(email.attachments),
  };
};

/** The mail thread saved on an RFQ, if it came from a connected mailbox. */
export const mailThreadOf = (extracted: unknown): MailThread | null => {
  const mail =
    extracted && typeof extracted === "object"
      ? (extracted as { mail?: unknown }).mail
      : null;
  if (!mail || typeof mail !== "object") {
    return null;
  }
  const m = mail as Record<string, unknown>;
  if (
    (m.provider !== "gmail" && m.provider !== "outlook") ||
    typeof m.attachmentsHash !== "string"
  ) {
    return null;
  }
  return {
    provider: m.provider,
    attachmentsHash: m.attachmentsHash,
    threadId: typeof m.threadId === "string" ? m.threadId : null,
  };
};
