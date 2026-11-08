// Mail that reaches a shop's Takumo address (erp-…@, rfq-…@, ask-…@, docs-…@) arrives from
// services/mail as a signed webhook. These checks decide whether to trust it:
// the signature and its age, which shop address it's for, and whether the
// sender is one the shop allows and really sent it (SPF/DKIM/DMARC as the
// mail receiver found them). Pure, so tested.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const INBOUND_KINDS = ["erp", "rfq", "ask", "docs"] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];

/** How old a signed request may be (clock skew plus retries). */
const MAX_AGE_SECONDS = 300;

const ADDRESS = /^(erp|rfq|docs|ask)-([a-z0-9]{8,32})@(.+)$/;
const DOMAIN_OF = /@([^@>\s]+)>?\s*$/;
const ANGLE = /<([^>]+)>/;
const LEADING_AT = /^@/;
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_LENGTH = 12;

/** A new address token: 12 letters and digits (about 62 bits). */
export const newToken = () =>
  Array.from(
    randomBytes(TOKEN_LENGTH),
    (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]
  ).join("");

/** "erp-k3j…@in.takumo.ai" → { kind: "erp", token }, or null if it isn't ours. */
export const parseAddress = (recipient: string, domain: string) => {
  const m = recipient.trim().toLowerCase().match(ADDRESS);
  if (!m || m[3] !== domain.toLowerCase()) {
    return null;
  }
  const kind = m[1];
  return (INBOUND_KINDS as readonly string[]).includes(kind)
    ? { kind: kind as InboundKind, token: m[2] }
    : null;
};

export const addressFor = (kind: InboundKind, token: string, domain: string) =>
  `${kind}-${token}@${domain}`;

/** The bytes services/mail signs: `${timestamp}.${recipients}.${mailFrom}.` + body. */
const signedBytes = (
  timestamp: string,
  recipients: string,
  mailFrom: string,
  body: Uint8Array
) =>
  Buffer.concat([
    Buffer.from(`${timestamp}.${recipients}.${mailFrom}.`, "utf8"),
    Buffer.from(body),
  ]);

export const sign = (
  secret: string,
  timestamp: string,
  recipients: string,
  mailFrom: string,
  body: Uint8Array
) =>
  createHmac("sha256", secret)
    .update(signedBytes(timestamp, recipients, mailFrom, body))
    .digest("hex");

export const verifySignature = (input: {
  body: Uint8Array;
  mailFrom: string;
  nowSeconds: number;
  recipients: string;
  secret: string;
  signature: string | null;
  timestamp: string | null;
}): { ok: true } | { ok: false; error: string } => {
  const { timestamp, signature } = input;
  if (!(timestamp && signature)) {
    return { ok: false, error: "Unsigned request." };
  }
  const age = Math.abs(input.nowSeconds - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_AGE_SECONDS) {
    return { ok: false, error: "Signature expired." };
  }
  const expected = Buffer.from(
    sign(input.secret, timestamp, input.recipients, input.mailFrom, input.body),
    "hex"
  );
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, error: "Bad signature." };
};

/** The address inside "Name <a@b.com>" (lowercased), or the text itself. */
export const emailAddress = (value: string | null | undefined) => {
  if (!value) {
    return null;
  }
  const inner = value.match(ANGLE)?.[1] ?? value;
  const address = inner.trim().toLowerCase();
  return address.includes("@") ? address : null;
};

export const domainOf = (address: string) =>
  address.match(DOMAIN_OF)?.[1]?.toLowerCase() ?? null;

/**
 * Whether the shop lets this sender use the address: an exact address
 * ("reports@shop.com") or a whole domain ("@shop.com" or "shop.com").
 */
export const senderAllowed = (from: string | null, allowed: string[]) => {
  const address = emailAddress(from);
  if (!address) {
    return false;
  }
  const domain = domainOf(address);
  return allowed.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) {
      return false;
    }
    if (rule.includes("@") && !rule.startsWith("@")) {
      return rule === address;
    }
    return domain === rule.replace(LEADING_AT, "");
  });
};

export interface InboundAuth {
  dkim: string;
  dkimDomains: string[];
  dmarc: string;
  from: string | null;
  spf: string;
}

/** The receiver's JSON header, defensively: missing parts read as "none". */
export const parseAuth = (header: string | null): InboundAuth => {
  let raw: Record<string, unknown> = {};
  try {
    raw = header ? (JSON.parse(header) as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  const word = (v: unknown) =>
    typeof v === "string" ? v.toLowerCase() : "none";
  return {
    spf: word(raw.spf),
    dkim: word(raw.dkim),
    dmarc: word(raw.dmarc),
    dkimDomains: Array.isArray(raw.dkimDomains)
      ? raw.dkimDomains
          .filter((d): d is string => typeof d === "string")
          .map((d) => d.toLowerCase())
      : [],
    from: typeof raw.from === "string" ? raw.from : null,
  };
};

const aligned = (a: string | null, b: string | null) =>
  Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));

/**
 * Whether the From address is really the sender's: DMARC passed for its
 * domain (as the mail service read the From header), or DKIM
 * passed for the From domain, or SPF passed for an envelope sender in the
 * From domain. A forged From fails all three.
 */
export const authenticated = (
  auth: InboundAuth,
  from: string | null,
  mailFrom: string | null
) => {
  const fromDomain = domainOf(emailAddress(from) ?? "");
  if (!fromDomain) {
    return false;
  }
  // DMARC is judged on the From domain the mail service read: it only
  // vouches for this sender when that is this domain (security audit M3).
  if (
    auth.dmarc === "pass" &&
    domainOf(emailAddress(auth.from) ?? "") === fromDomain
  ) {
    return true;
  }
  if (
    auth.dkim === "pass" &&
    auth.dkimDomains.some((d) => aligned(d, fromDomain))
  ) {
    return true;
  }
  const envelopeDomain = domainOf(emailAddress(mailFrom) ?? "");
  return auth.spf === "pass" && aligned(envelopeDomain, fromDomain);
};
