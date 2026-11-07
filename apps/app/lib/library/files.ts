// What kind of file an upload really is, from its first bytes, not from what
// the browser or the file name claims. Shared by every upload path.
import { createHash } from "node:crypto";
import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from "../knowledge/types";

const MEDIA: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const TEXT = new Set([".txt", ".md", ".csv"]);
const SNIFF_BYTES = 8192;

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((b, i) => bytes[offset + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const looksLike: Record<string, (bytes: Uint8Array) => boolean> = {
  ".pdf": (b) => startsWith(b, ascii("%PDF-")),
  // A Word file is a zip holding word/document.xml.
  ".docx": (b) =>
    startsWith(b, [0x50, 0x4b, 0x03, 0x04]) &&
    new TextDecoder("latin1")
      .decode(b.subarray(0, Math.min(b.length, 64 * 1024)))
      .includes("word/"),
  ".jpg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  ".jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  ".png": (b) =>
    startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ".webp": (b) =>
    startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
};

/** Plain text: valid UTF-8 with no NUL bytes (a binary file renamed .txt isn't). */
const isText = (bytes: Uint8Array) => {
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) {
    return false;
  }
  try {
    // A multi-byte character cut at the end of the sample is fine.
    new TextDecoder("utf-8", { fatal: true }).decode(head, {
      stream: head.length < bytes.length,
    });
    return true;
  } catch {
    return false;
  }
};

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
};

export type FileCheck =
  | { ok: true; mimeType: string; size: number }
  | { ok: false; error: string };

/**
 * Whether an upload is a document Takumo reads: an allowed extension, within
 * the size limit, and content that matches the extension. The media type is
 * decided here, never taken from the request.
 */
export const checkDocumentFile = (
  name: string,
  bytes: Uint8Array
): FileCheck => {
  if (bytes.length === 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: "Files can be up to 20 MB." };
  }
  const ext = extensionOf(name);
  if (!(DOCUMENT_TYPES as readonly string[]).includes(ext)) {
    return {
      ok: false,
      error: `Takumo reads ${DOCUMENT_TYPES.join(", ")} files.`,
    };
  }
  const matches = TEXT.has(ext) ? isText(bytes) : looksLike[ext]?.(bytes);
  if (!matches) {
    return {
      ok: false,
      error: `That file isn't a real ${ext.slice(1).toUpperCase()} file. Save it again in that format and upload it.`,
    };
  }
  return { ok: true, mimeType: MEDIA[ext], size: bytes.length };
};

export const sha256Hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
