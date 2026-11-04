// The files that come with an RFQ (docs/PRODUCT-PLAN.md F2.1): what kind each
// is, unpacking zipped RFQ packages safely, and the limits on what's kept.
// Pure (no database, no model calls), so tested on fixtures.

import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { DOCUMENT_TYPES, IMAGE_TYPES, MODEL_TYPES } from "./file-types";
import type { RfqFileKind } from "./types";

export {
  DOCUMENT_TYPES,
  IMAGE_TYPES,
  MODEL_TYPES,
  PACKAGE_TYPES,
} from "./file-types";

export interface IncomingFile {
  bytes: Uint8Array;
  name: string;
}

/** One file is never kept above this. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** All of one RFQ's files together. */
export const MAX_RFQ_FILES_BYTES = 50 * 1024 * 1024;
/** Files kept per RFQ. */
export const MAX_RFQ_FILES = 60;
/** A zip package: entries looked at, and bytes unpacked in total. */
export const MAX_ZIP_ENTRIES = 200;
export const MAX_ZIP_BYTES = 100 * 1024 * 1024;
/** Images smaller than this are signature logos, not drawings. */
const MIN_IMAGE_BYTES = 15 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".rtf": "application/rtf",
  ".step": "model/step",
  ".stp": "model/step",
  ".iges": "model/iges",
  ".igs": "model/iges",
  ".stl": "model/stl",
  ".3mf": "model/3mf",
  ".dxf": "image/vnd.dxf",
  ".dwg": "image/vnd.dwg",
};

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
};

export const mediaTypeOf = (name: string) =>
  MEDIA_TYPES[extensionOf(name)] ?? "application/octet-stream";

const has = (list: readonly string[], name: string) =>
  list.includes(extensionOf(name));

// Words a drawing's title block and notes carry. Two or more → a drawing.
const DRAWING_SIGNS = [
  /unless\s+otherwise\s+specified/i,
  /\btolerances?\b/i,
  /\b(third|first|3rd|1st)\s+angle\b/i,
  /\bscale\b\s*[:\d]/i,
  /\bdwg\b|\bdrawing\s+(no|number|#)/i,
  /\bsheet\s+\d+\s+of\s+\d+\b/i,
  /\brev(ision)?\b\s*[:.]?\s*[a-z0-9]/i,
  /\bdo\s+not\s+scale\b/i,
  /\bbreak\s+(all\s+)?(sharp\s+)?edges\b/i,
  /\bdimensions?\s+(are\s+)?in\s+(inches|mm|millimet)/i,
  /\bmaterial\s*:/i,
  /\bfinish\s*:/i,
];
const DRAWING_NAME =
  /(dwg|drw|drawing|print|\bdet(ail)?\b|\brev[\s_-]?[a-z0-9]\b)/i;
/** Under this many characters per page, a PDF page is a scan. */
const SCANNED_CHARS = 40;

/** A PDF whose pages have (almost) no text of their own: scanned images. */
export const isScanned = (pages: string[]) =>
  pages.length > 0 && pages.every((p) => p.trim().length < SCANNED_CHARS);

/** True when a PDF's text reads like an engineering drawing. */
export const looksLikeDrawing = (pages: string[]) => {
  const text = pages.join("\n").slice(0, 20_000);
  return DRAWING_SIGNS.filter((sign) => sign.test(text)).length >= 2;
};

/**
 * What a file is. A PDF is a drawing when its text reads like one, or when
 * it's a scan whose name looks like a drawing; otherwise a document.
 */
export const kindOf = (
  name: string,
  pdfPages: string[] | null = null
): RfqFileKind => {
  if (has(MODEL_TYPES, name)) {
    return "model";
  }
  if (has([".dxf", ".dwg"], name)) {
    // CAD files: kept, but the drawing reader reads PDFs and images only,
    // so like a 3D model they ask the customer for a PDF drawing.
    return "model";
  }
  if (has(IMAGE_TYPES, name)) {
    return DRAWING_NAME.test(name) ? "drawing" : "image";
  }
  if (has(DOCUMENT_TYPES, name)) {
    return "document";
  }
  if (extensionOf(name) === ".pdf") {
    const pages = pdfPages ?? [];
    if (looksLikeDrawing(pages)) {
      return "drawing";
    }
    return (isScanned(pages) || pages.length === 0) && DRAWING_NAME.test(name)
      ? "drawing"
      : "document";
  }
  return "other";
};

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

/** The name without folders, as it should be shown and downloaded. */
export const baseName = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1).trim() || "file";

/**
 * Unpack a zipped RFQ package. Never more than MAX_ZIP_ENTRIES files or
 * MAX_ZIP_BYTES unpacked: a zip bomb stops at the limit, with a note.
 * Zips inside the zip are kept as they are, not unpacked.
 */
export const unpackZip = (
  name: string,
  bytes: Uint8Array
): { files: IncomingFile[]; skipped: string[] } => {
  const skipped: string[] = [];
  let entries = 0;
  let declared = 0;
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes, {
      filter: (file) => {
        if (file.name.endsWith("/") || JUNK.test(file.name)) {
          return false;
        }
        entries += 1;
        if (entries > MAX_ZIP_ENTRIES) {
          return false;
        }
        if (file.originalSize > MAX_FILE_BYTES) {
          skipped.push(`${baseName(file.name)} (in ${name}): over 20 MB`);
          return false;
        }
        if (declared + file.originalSize > MAX_ZIP_BYTES) {
          return false;
        }
        declared += file.originalSize;
        return true;
      },
    });
  } catch {
    return { files: [], skipped: [`${name}: not a zip file Takumo can open`] };
  }
  if (entries > MAX_ZIP_ENTRIES) {
    skipped.push(
      `${name}: only the first ${MAX_ZIP_ENTRIES} files were unpacked`
    );
  }
  const files: IncomingFile[] = [];
  let total = 0;
  for (const [path, data] of Object.entries(unpacked)) {
    // The sizes in a zip's header can lie; check what was really unpacked.
    total += data.length;
    if (data.length > MAX_FILE_BYTES || total > MAX_ZIP_BYTES) {
      skipped.push(`${baseName(path)} (in ${name}): too large once unpacked`);
      continue;
    }
    files.push({ name: baseName(path), bytes: data });
  }
  return { files, skipped };
};

/** Zips replaced by what's in them; empty files and signature logos dropped. */
export const expandPackage = (incoming: IncomingFile[]) => {
  const files: IncomingFile[] = [];
  const skipped: string[] = [];
  for (const file of incoming) {
    if (file.bytes.length === 0) {
      continue;
    }
    if (extensionOf(file.name) === ".zip") {
      const out = unpackZip(file.name, file.bytes);
      files.push(...out.files);
      skipped.push(...out.skipped);
      continue;
    }
    if (has(IMAGE_TYPES, file.name) && file.bytes.length < MIN_IMAGE_BYTES) {
      // image001.png in an email signature.
      continue;
    }
    files.push(file);
  }
  return { files, skipped };
};

export const sha256Of = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Apply the size limits: each file up to MAX_FILE_BYTES, all together up to
 * MAX_RFQ_FILES_BYTES, the same file once. What's left out is listed.
 */
export const withinLimits = <T extends { bytes: Uint8Array; name: string }>(
  files: (T & { sha256: string })[]
) => {
  const kept: (T & { sha256: string })[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (seen.has(file.sha256)) {
      continue;
    }
    if (file.bytes.length > MAX_FILE_BYTES) {
      skipped.push(`${file.name}: over 20 MB`);
      continue;
    }
    if (kept.length >= MAX_RFQ_FILES) {
      skipped.push(`${file.name}: more than ${MAX_RFQ_FILES} files`);
      continue;
    }
    if (total + file.bytes.length > MAX_RFQ_FILES_BYTES) {
      skipped.push(`${file.name}: the RFQ's files are over 50 MB together`);
      continue;
    }
    seen.add(file.sha256);
    total += file.bytes.length;
    kept.push(file);
  }
  return { kept, skipped };
};

const ADDRESS = /<([^>]+)>/;

/** "Jo Buyer <Jo@Acme.com>" → "jo@acme.com"; null when there's no address. */
export const senderAddress = (sender: string | null) => {
  if (!sender) {
    return null;
  }
  const address = (sender.match(ADDRESS)?.[1] ?? sender).trim().toLowerCase();
  return address.includes("@") ? address : null;
};

/**
 * Two RFQs are the same request when the same sender sent the same files
 * (F2.1-R7). The key compares them; null when there are no files to compare.
 */
export const duplicateKey = (sender: string | null, hashes: string[]) => {
  const unique = [...new Set(hashes)].sort();
  if (unique.length === 0) {
    return null;
  }
  return `${senderAddress(sender) ?? ""}|${unique.join(",")}`;
};

/** Days within which the same request counts as the same RFQ. */
export const DUPLICATE_DAYS = 7;

/** Shorter requests ("Please quote, thanks") are too generic to call the same. */
const MIN_REQUEST_CHARS = 80;
/** Only ever a forward: Gmail's and Apple Mail's markers. */
const FORWARD_MARKER =
  /^[ \t>]*(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:)[ \t]*$/im;
/** Outlook's: the same line starts a reply, so trusted only under "FW:". */
const OUTLOOK_MARKER =
  /^[ \t>]*(?:-{2,}\s*original message\s*-{2,}|_{10,})[ \t]*$/im;
const FORWARD_SUBJECT = /^\s*(?:fwd?|fw)\s*:/i;
/** The header lines a forward repeats: who, when, to whom. */
const FORWARD_HEADER =
  /^[ \t>]*(?:from|sent|date|to|cc|subject|reply-to)\s*:.*$/gim;
const NOT_LETTER_OR_DIGIT = /[^a-z0-9]+/g;
/** "Fwd: RE: FW:" and friends, however many, at the start of a subject. */
const REPLY_PREFIXES = /^(?:\s*(?:re|fwd?|fw|aw|wg|sv)\s*:\s*)+/i;

/**
 * The subject without reply and forward prefixes, letters and digits only:
 * the same request keeps its subject when forwarded or sent again, and
 * templated RFQs that differ only in the subject's part number stay apart.
 */
export const subjectKey = (subject: string | null) =>
  (subject ?? "")
    .replace(REPLY_PREFIXES, "")
    .toLowerCase()
    .replace(NOT_LETTER_OR_DIGIT, "");

/**
 * The request itself, for spotting the same text-only RFQ twice (F2.1-R7):
 * for a forward, only the forwarded message (the note and the From/To lines
 * dropped), so two people forwarding one customer email match each other and
 * the original. Lower-cased letters and digits only, so line breaks and
 * punctuation that mail programs change don't matter. Compared for equality,
 * never "contains": a reply quoting an old RFQ is a new request. Null when
 * the text is too short to tell.
 */
export const requestText = (subject: string | null, body: string) => {
  const marker =
    body.match(FORWARD_MARKER) ??
    (FORWARD_SUBJECT.test(subject ?? "") ? body.match(OUTLOOK_MARKER) : null);
  const message =
    marker?.index === undefined
      ? body
      : body.slice(marker.index + marker[0].length).replace(FORWARD_HEADER, "");
  const text = message.toLowerCase().replace(NOT_LETTER_OR_DIGIT, "");
  return text.length >= MIN_REQUEST_CHARS ? text : null;
};
