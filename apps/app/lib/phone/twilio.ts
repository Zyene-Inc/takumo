// Notes by text message (docs/PRODUCT-PLAN.md F6.1): the parts of Twilio's
// webhook and phone numbers that need no network or database. Pure, so tested.

import {
  createHash,
  createHmac,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

export type PhoneChannel = "sms" | "whatsapp";

const NON_DIGITS = /\D/g;
const WHATSAPP = /^whatsapp:/i;
const US_NUMBER = /^\+1(\d{3})(\d{3})(\d{4})$/;

/**
 * A phone number as E.164 ("+15551234567"), or null when it can't be one.
 * Without a country code, 10 digits are read as a US/Canada number.
 */
export const normalizePhone = (input: string | null | undefined) => {
  const text = (input ?? "").trim().replace(WHATSAPP, "");
  if (!text) {
    return null;
  }
  const digits = text.replace(NON_DIGITS, "");
  let e164: string;
  if (text.startsWith("+")) {
    e164 = `+${digits}`;
  } else if (text.startsWith("00")) {
    e164 = `+${digits.slice(2)}`;
  } else if (digits.length === 10) {
    e164 = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    e164 = `+${digits}`;
  } else {
    return null;
  }
  const n = e164.length - 1;
  return n >= 8 && n <= 15 && e164[1] !== "0" ? e164 : null;
};

/** "+15551234567" → "+1 555-123-4567"; other countries as given. */
export const displayPhone = (e164: string) => {
  const m = e164.match(US_NUMBER);
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : e164;
};

/** Who sent it and on which channel, from Twilio's From parameter. */
export const senderOf = (from: string | null | undefined) => {
  if (!from) {
    return null;
  }
  const channel: PhoneChannel = WHATSAPP.test(from) ? "whatsapp" : "sms";
  const phone = normalizePhone(from);
  return phone ? { phone, channel } : null;
};

/**
 * Twilio's request signature: HMAC-SHA1 (auth token) over the URL it called
 * followed by every POST parameter, sorted by name, as name + value; base64.
 */
export const twilioSignature = (
  authToken: string,
  url: string,
  params: ReadonlyArray<readonly [string, string]>
) => {
  const sorted = [...params].sort(([a, av], [b, bv]) => {
    if (a !== b) {
      return a < b ? -1 : 1;
    }
    return av < bv ? -1 : 1;
  });
  const data = url + sorted.map(([k, v]) => k + v).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
};

export const verifyTwilioSignature = (input: {
  authToken: string;
  params: ReadonlyArray<readonly [string, string]>;
  signature: string | null;
  url: string;
}) => {
  if (!input.signature) {
    return false;
  }
  const expected = Buffer.from(
    twilioSignature(input.authToken, input.url, input.params)
  );
  const given = Buffer.from(input.signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/** What one inbound message carries: its text and its first media file. */
export interface InboundText {
  body: string;
  /** Media other than audio (photos, PDFs): not read here. */
  hasOtherMedia: boolean;
  media: { contentType: string; url: string } | null;
  sid: string;
}

export const readInbound = (
  params: ReadonlyMap<string, string>
): InboundText | null => {
  const sid = params.get("MessageSid") ?? params.get("SmsMessageSid");
  if (!sid) {
    return null;
  }
  const count = Number(params.get("NumMedia") ?? 0) || 0;
  let media: InboundText["media"] = null;
  let hasOtherMedia = false;
  for (let i = 0; i < count; i++) {
    const url = params.get(`MediaUrl${i}`);
    const contentType = (
      params.get(`MediaContentType${i}`) ?? ""
    ).toLowerCase();
    if (!url) {
      continue;
    }
    if (contentType.startsWith("audio/") && !media) {
      media = { url, contentType };
    } else {
      hasOtherMedia = true;
    }
  }
  return { sid, body: (params.get("Body") ?? "").trim(), media, hasOtherMedia };
};

/** An empty TwiML answer: replies are sent separately, once the note is read. */
export const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// ---------------------------------------------------------------------------
// Confirmation codes
// ---------------------------------------------------------------------------

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_RESEND_MS = 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Stored instead of the code; salted with the registration's id. */
export const hashCode = (id: string, code: string) =>
  createHash("sha256").update(`${id}:${code.trim()}`).digest("hex");

type CodeCheck =
  | { ok: true }
  | { ok: false; error: string; spent?: boolean };

/** Whether `code` confirms this registration now. */
export const checkCode = (
  registration: {
    attempts: number;
    codeExpiresAt: Date | null;
    codeHash: string | null;
    id: string;
  },
  code: string,
  now: Date
): CodeCheck => {
  if (!(registration.codeHash && registration.codeExpiresAt)) {
    return { ok: false, error: "Send a code first." };
  }
  if (registration.attempts >= MAX_CODE_ATTEMPTS) {
    return {
      ok: false,
      spent: true,
      error: "Too many wrong codes. Send a new one.",
    };
  }
  if (registration.codeExpiresAt.getTime() < now.getTime()) {
    return { ok: false, error: "That code has expired. Send a new one." };
  }
  const given = Buffer.from(hashCode(registration.id, code));
  const expected = Buffer.from(registration.codeHash);
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, error: "That code isn't right." };
};

export const codeMessage = (code: string) =>
  `${code} is your Takumo code. It confirms this phone can send notes to your shop. It expires in 10 minutes.`;

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** The short confirmation sent back once a note is read (F6.1-R3). */
export const replyText = (result: { failed: boolean; proposed: string[] }) => {
  if (result.failed) {
    return "Got it. Your note is saved, but Takumo couldn't read it just now; it can be read again from Voice notes.";
  }
  const n = result.proposed.length;
  if (n === 0) {
    return "Got it. Saved as a note; nothing in it changes the shop's records.";
  }
  return `Got it: ${n} fact${n === 1 ? "" : "s"} for your supervisor to review (${result.proposed.join(", ")}).`;
};

export const OTHER_MEDIA_REPLY =
  "Takumo reads voice notes and text here. Email documents and photos to your shop's documents address instead.";

export const EMPTY_REPLY =
  "Send a voice note, or a few words about the job, and Takumo will pass it on for review.";
