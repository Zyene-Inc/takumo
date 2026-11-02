// The text of an RFQ, from an uploaded file or package, a pasted email, or a
// call, plus the files that came with it. No database or model calls, so
// tested on fixtures.

import { extractPages } from "../knowledge/extract";
import {
  expandPackage,
  extensionOf,
  type IncomingFile,
  PACKAGE_TYPES,
} from "./attachments";
import { channelOf } from "./channel";
import { parseEmail } from "./email";
import { SCREEN_HEADERS } from "./screen";
import { RFQ_TYPES, type RfqSource } from "./types";

export interface RfqText {
  body: string;
  /** Files that came with the RFQ (attachments, a package), kept on it. */
  files: IncomingFile[];
  /** An email's headers the RFQ screening reads (lower-cased names). */
  headers?: Record<string, string>;
  sender: string | null;
  source: RfqSource;
  subject: string | null;
}

/** Characters of RFQ text sent to the model; real RFQs are far shorter. */
export const MAX_RFQ_CHARS = 60_000;

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

/**
 * A readable file's text. The PDF reader may take over the buffer it's given,
 * so it gets a copy: the original bytes are kept on the RFQ.
 */
const fileText = async (file: IncomingFile) =>
  pagesText(await extractPages(file.name, file.bytes.slice()));

/** The text of the readable files, each under a heading. */
const filesText = async (files: IncomingFile[], label: string) => {
  const parts: string[] = [];
  for (const file of files) {
    if (!ATTACHMENT_TYPES.includes(extensionOf(file.name))) {
      continue;
    }
    try {
      const text = await fileText(file);
      if (text) {
        parts.push(`--- ${label}: ${file.name} ---\n${text}`);
      }
    } catch {
      parts.push(`--- ${label}: ${file.name} (couldn't be read) ---`);
    }
  }
  return parts;
};

/** A pasted email: picks up "Subject:" and "From:" lines when they're there. */
export const readPasted = (text: string): RfqText => {
  const header = text.slice(0, 2000);
  const subject = header.match(SUBJECT_LINE)?.[1]?.trim() ?? null;
  const sender = header.match(FROM_LINE)?.[1]?.trim() ?? null;
  const body = clip(text.trim());
  const channel = channelOf({ body, sender, subject });
  let source: RfqSource = subject || sender ? "email" : "paste";
  if (channel !== "email") {
    source = channel;
  }
  return { source, subject, sender, body, files: [] };
};

/** Notes from a phone call (typed or dictated) as an RFQ. */
export const readCall = (text: string): RfqText => ({
  source: "phone",
  subject: null,
  sender: null,
  body: clip(text.trim()),
  files: [],
});

/** A saved email (.eml): its body, the text of its attachments, its files. */
const readEmail = async (bytes: Uint8Array): Promise<RfqText> => {
  const email = parseEmail(new TextDecoder().decode(bytes));
  // Zipped packages are unpacked so the documents inside are read too.
  const { files } = expandPackage(email.attachments);
  const body = clip(
    [email.body, ...(await filesText(files, "Attachment"))]
      .filter(Boolean)
      .join("\n\n")
  );
  return {
    source: channelOf({ body, sender: email.from, subject: email.subject }),
    subject: email.subject,
    sender: email.from,
    body,
    files: email.attachments,
    headers: Object.fromEntries(
      SCREEN_HEADERS.flatMap((name) => {
        const value = email.headers.get(name);
        return value === undefined ? [] : [[name, value]];
      })
    ),
  };
};

export const readRfqFile = async (
  name: string,
  bytes: Uint8Array
): Promise<RfqText> => {
  const ext = extensionOf(name);
  if (!(RFQ_TYPES as readonly string[]).includes(ext)) {
    throw new Error(`Takumo reads RFQs as ${RFQ_TYPES.join(", ")} files.`);
  }
  if (ext === ".eml") {
    return readEmail(bytes);
  }
  const text = await fileText({ name, bytes });
  const file = { name, bytes };
  if (ext === ".txt" || ext === ".md") {
    return { ...readPasted(text), source: "upload", files: [file] };
  }
  return {
    source: "upload",
    subject: null,
    sender: null,
    body: clip(text),
    files: [file],
  };
};

const fileList = (files: IncomingFile[]) =>
  files.map((f) => `- ${f.name}`).join("\n");

/**
 * An RFQ package dropped on /quotes: any mix of the RFQ (PDF, Word, a saved
 * email), drawings, 3D models and zips. The text is read from what can be
 * read; every file is kept.
 */
export const readRfqUpload = async (
  uploads: IncomingFile[]
): Promise<RfqText> => {
  for (const file of uploads) {
    if (
      !(PACKAGE_TYPES as readonly string[]).includes(extensionOf(file.name))
    ) {
      throw new Error(
        `${file.name}: Takumo takes PDFs, Word, saved emails, drawings, 3D models, images and zips.`
      );
    }
  }
  const emails = uploads.filter((f) => extensionOf(f.name) === ".eml");
  const others = uploads.filter((f) => extensionOf(f.name) !== ".eml");
  const read = await Promise.all(emails.map((f) => readEmail(f.bytes)));
  const { files: unpacked } = expandPackage(others);
  const parts = [
    ...read.map((r) => r.body),
    ...(await filesText(unpacked, "File")),
  ].filter(Boolean);
  const files = [...read.flatMap((r) => r.files), ...others];
  const body = parts.length
    ? parts.join("\n\n")
    : `Files received with this RFQ:\n${fileList(expandPackage(files).files)}`;
  const first = read[0];
  return {
    source: first ? first.source : "upload",
    subject: first?.subject ?? null,
    sender: first?.sender ?? null,
    body: clip(body),
    files,
  };
};
