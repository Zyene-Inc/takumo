// Signed links in emails (docs/PRODUCT-PLAN.md F4.2): approve or reject a
// fact, mark a quote won or lost, unsubscribe, and the brief's tracked links.
// A token is the payload (base64url JSON) and its HMAC-SHA256, so nobody can
// make or change one without the server's secret. Action links expire after
// 72 hours and carry a nonce that's stored when used (single use); they act
// as the person they were sent to, and only after a confirmation (POST).
// Pure, so tested; the secret comes from the caller.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ACTION_TTL_S = 72 * 60 * 60;
/** Unsubscribe and tracked links stay good longer than a brief is read. */
export const LINK_TTL_S = 60 * 24 * 60 * 60;

export type LinkAction =
  | { kind: "fact"; factId: string; decision: "approve" | "reject" }
  | { kind: "quote"; rfqId: string; lineId: string; decision: "won" | "lost" };

export type LinkPayload =
  | {
      /** An action (F4.2), used once. */
      t: "act";
      o: string;
      u: string;
      a: LinkAction;
      n: string;
      e: number;
    }
  | {
      /** A link in the brief: counted, then on to `p` (an app path). */
      t: "go";
      o: string;
      u: string;
      s: string;
      p: string;
      e: number;
    }
  | {
      /** Stop one brief section (`s`), alerts of one type, or everything. */
      t: "unsub";
      o: string;
      u: string;
      s: string;
      e: number;
    };

export type Verified =
  | { ok: true; payload: LinkPayload }
  | { ok: false; reason: "invalid" | "expired" };

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

const mac = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest();

export const newNonce = () => randomBytes(16).toString("base64url");

/** A token for `payload`, signed with `secret`. */
export const signLink = (secret: string, payload: LinkPayload) => {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(secret, body))}`;
};

/** An action link's payload, expiring 72 hours from `now`. */
export const actionPayload = (
  orgId: string,
  userId: string,
  action: LinkAction,
  now: Date,
  nonce = newNonce()
): LinkPayload => ({
  t: "act",
  o: orgId,
  u: userId,
  a: action,
  n: nonce,
  e: Math.floor(now.getTime() / 1000) + ACTION_TTL_S,
});

const isPayload = (value: unknown): value is LinkPayload => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.o !== "string" ||
    typeof v.u !== "string" ||
    typeof v.e !== "number"
  ) {
    return false;
  }
  if (v.t === "act") {
    const a = v.a as Record<string, unknown> | undefined;
    return (
      typeof v.n === "string" &&
      !!a &&
      ((a.kind === "fact" &&
        typeof a.factId === "string" &&
        (a.decision === "approve" || a.decision === "reject")) ||
        (a.kind === "quote" &&
          typeof a.rfqId === "string" &&
          typeof a.lineId === "string" &&
          (a.decision === "won" || a.decision === "lost")))
    );
  }
  if (v.t === "go") {
    return (
      typeof v.s === "string" &&
      typeof v.p === "string" &&
      // Only paths inside the app: never a way to send someone elsewhere.
      v.p.startsWith("/") &&
      !v.p.startsWith("//")
    );
  }
  return v.t === "unsub" && typeof v.s === "string";
};

/** The payload when the token is genuine and not expired. */
export const verifyLink = (
  secret: string,
  token: string | null | undefined,
  now: Date
): Verified => {
  const [body, sig, extra] = (token ?? "").split(".");
  if (!(body && sig) || extra !== undefined) {
    return { ok: false, reason: "invalid" };
  }
  const expected = mac(secret, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "invalid" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!isPayload(payload)) {
    return { ok: false, reason: "invalid" };
  }
  if (payload.e * 1000 < now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
};
