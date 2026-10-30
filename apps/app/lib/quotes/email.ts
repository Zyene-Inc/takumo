// Reads an RFQ email saved as .eml (RFC 822 / MIME): subject, sender, the
// plain-text body, and attachments (often the RFQ itself as a PDF). Pure.

export interface EmailAttachment {
  bytes: Uint8Array;
  name: string;
}

export interface ParsedEmail {
  attachments: EmailAttachment[];
  body: string;
  from: string | null;
  subject: string | null;
}

interface MimePart {
  body: string;
  headers: Map<string, string>;
}

const HEADER_END = /\r?\n\r?\n/;
const FOLDED = /\r?\n[ \t]+/g;
const ENCODED_WORD = /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi;
const SOFT_BREAK = /=\r?\n/g;
const QP_BYTE = /=([0-9a-f]{2})/gi;
const TAGS = /<[^>]+>/g;
const BLOCK_TAGS = /<\/(p|div|tr|li|h\d)>|<br\s*\/?>/gi;
const SPACE_RUNS = /[ \t]+/g;
const EXTRA_BLANKS = /\n{3,}/g;
const LINE_BREAK = /\r?\n/;
const LEADING_BREAK = /^\r?\n/;
const UTF8_PREFIX = /^utf-8''/i;

const parseHeaders = (raw: string) => {
  const headers = new Map<string, string>();
  for (const line of raw.replace(FOLDED, " ").split(LINE_BREAK)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      if (!headers.has(name)) {
        headers.set(name, line.slice(colon + 1).trim());
      }
    }
  }
  return headers;
};

const splitPart = (raw: string): MimePart => {
  const match = HEADER_END.exec(raw);
  if (!match) {
    return { headers: parseHeaders(raw), body: "" };
  }
  return {
    headers: parseHeaders(raw.slice(0, match.index)),
    body: raw.slice(match.index + match[0].length),
  };
};

const param = (header: string | undefined, name: string) => {
  const match = header?.match(
    new RegExp(`${name}\\*?=(?:"([^"]*)"|([^;\\s]*))`, "i")
  );
  const value = match?.[1] ?? match?.[2];
  return value ? decodeWords(value.replace(UTF8_PREFIX, "")) : null;
};

const bytesToText = (bytes: Uint8Array, charset: string | null) => {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

const base64Bytes = (text: string) =>
  new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "base64"));

const quotedPrintableBytes = (text: string) => {
  const ascii = text
    .replace(SOFT_BREAK, "")
    .replace(QP_BYTE, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
  // Every character is now one byte (0–255).
  return Uint8Array.from(ascii, (c) => c.charCodeAt(0) % 256);
};

/** Subjects and file names like =?UTF-8?B?…?= */
export const decodeWords = (value: string) =>
  value.replace(ENCODED_WORD, (_, charset: string, kind: string, text) =>
    bytesToText(
      kind.toLowerCase() === "b"
        ? base64Bytes(text)
        : quotedPrintableBytes(text.replaceAll("_", " ")),
      charset
    )
  );

const decodeBody = (part: MimePart) => {
  const encoding = (
    part.headers.get("content-transfer-encoding") ?? ""
  ).toLowerCase();
  if (encoding === "base64") {
    return base64Bytes(part.body);
  }
  if (encoding === "quoted-printable") {
    return quotedPrintableBytes(part.body);
  }
  return Uint8Array.from(Buffer.from(part.body, "utf8"));
};

export const htmlToText = (html: string) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(BLOCK_TAGS, "\n")
    .replace(TAGS, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(SPACE_RUNS, " ")
    .replace(/ *\n */g, "\n")
    .replace(EXTRA_BLANKS, "\n\n")
    .trim();

const walk = (
  part: MimePart,
  found: { plain: string[]; html: string[]; attachments: EmailAttachment[] }
) => {
  const type = part.headers.get("content-type") ?? "text/plain";
  const mime = type.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("multipart/")) {
    const boundary = param(type, "boundary");
    if (!boundary) {
      return;
    }
    const pieces = part.body.split(`--${boundary}`);
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith("--")) {
        break;
      }
      walk(splitPart(piece.replace(LEADING_BREAK, "")), found);
    }
    return;
  }
  const disposition = part.headers.get("content-disposition");
  const name = param(disposition, "filename") ?? param(type, "name");
  if (name || disposition?.toLowerCase().startsWith("attachment")) {
    found.attachments.push({
      name: name ?? "attachment",
      bytes: decodeBody(part),
    });
    return;
  }
  const text = bytesToText(decodeBody(part), param(type, "charset"));
  if (mime === "text/html") {
    found.html.push(htmlToText(text));
  } else if (mime.startsWith("text/")) {
    found.plain.push(text.trim());
  }
};

export const parseEmail = (raw: string): ParsedEmail => {
  const top = splitPart(raw);
  const found = {
    plain: [] as string[],
    html: [] as string[],
    attachments: [] as EmailAttachment[],
  };
  walk(top, found);
  const subject = top.headers.get("subject");
  const from = top.headers.get("from");
  return {
    subject: subject ? decodeWords(subject) : null,
    from: from ? decodeWords(from) : null,
    body: (found.plain.length ? found.plain : found.html).join("\n\n").trim(),
    attachments: found.attachments,
  };
};
