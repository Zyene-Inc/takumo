// Hands a received message to the Takumo app and turns its answer into an
// SMTP reply: 2xx -> 250, a refusal (4xx) -> 5xx (permanent), anything else
// -> 451 (retry). Each reply carries its own enhanced status code (RFC 3463):
// the sender's mail system words the bounce from it, so "not on the allowed
// list" must not go out as 5.1.1 ("address not found").
import { sign } from "./signature.js";

export interface AuthSummary {
  dkim: "pass" | "fail" | "none";
  dkimDomains: string[];
  dmarc: "pass" | "fail" | "none";
  from: string;
  spf: string;
}

interface Delivery {
  auth: AuthSummary;
  mailFrom: string;
  raw: Buffer;
  recipients: string[];
  remoteIp: string;
}

export interface SmtpReply {
  code: 250 | 451 | 550 | 552;
  /** RFC 3463 code, e.g. "5.7.1"; sent before the message. */
  enhanced: string;
  message: string;
  /** HTTP status, or a short reason when there was none (timeout, network). */
  webhookStatus: number | "timeout" | "network-error";
}

const MAX_REASON_LENGTH = 200;

/** Makes the app's error text safe for one SMTP reply line. */
export function sanitizeReason(text: string): string {
  return text
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON_LENGTH);
}

function errorText(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (typeof error === "string") {
        const reason = sanitizeReason(error);
        return reason || null;
      }
    }
  } catch {
    // Not JSON: use the generic message.
  }
  return null;
}

const TEMPORARY = "Temporary failure handing over the message, try again later";

/**
 * 4xx answers that are our own problem, not the sender's: a signature the
 * app doesn't accept (the shared secret is out of step, e.g. mid-rotation),
 * a timeout, a rate limit. The sender keeps the message and retries.
 */
const OURS = new Set([401, 408, 429]);

/** The enhanced code for the app's refusal: what the sender is told went wrong. */
const refusalCode = (status: number) => {
  if (status === 404) {
    return "5.1.1"; // no such address
  }
  if (status === 403) {
    return "5.7.1"; // sender not allowed / not verified
  }
  return "5.6.0"; // the message itself wasn't accepted
};

/** Maps the webhook's HTTP answer to the SMTP reply for the sender. */
export function mapResponse(status: number, body: string): SmtpReply {
  if (status >= 200 && status < 300) {
    return {
      code: 250,
      enhanced: "2.0.0",
      message: "OK: message accepted",
      webhookStatus: status,
    };
  }
  if (status === 413) {
    return {
      code: 552,
      enhanced: "5.3.4",
      message: errorText(body) ?? "Message too large",
      webhookStatus: status,
    };
  }
  if (status >= 400 && status < 500 && !OURS.has(status)) {
    return {
      code: 550,
      enhanced: refusalCode(status),
      message: errorText(body) ?? "Message rejected by recipient system",
      webhookStatus: status,
    };
  }
  return {
    code: 451,
    enhanced: "4.3.0",
    message: TEMPORARY,
    webhookStatus: status,
  };
}

export function buildHeaders(
  secret: string,
  delivery: Delivery,
  now: () => number = Date.now
): Record<string, string> {
  const timestamp = Math.floor(now() / 1000).toString();
  const recipients = delivery.recipients.join(",");
  const signature = sign(
    secret,
    { timestamp, recipients, mailFrom: delivery.mailFrom },
    delivery.raw
  );
  return {
    "Content-Type": "message/rfc822",
    "X-Takumo-Timestamp": timestamp,
    "X-Takumo-Recipients": recipients,
    "X-Takumo-Mail-From": delivery.mailFrom,
    "X-Takumo-Remote-Ip": delivery.remoteIp,
    "X-Takumo-Auth": JSON.stringify(delivery.auth),
    "X-Takumo-Signature": signature,
  };
}

interface WebhookOptions {
  now?: () => number;
  secret: string;
  timeoutMs: number;
  url: string;
}

export async function deliver(
  options: WebhookOptions,
  delivery: Delivery
): Promise<SmtpReply> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: buildHeaders(options.secret, delivery, options.now),
      body: delivery.raw,
      redirect: "manual",
      signal,
    });
    // Only a 4xx body is used (for its error text); read at most what we need.
    const body =
      response.status >= 400 && response.status < 500
        ? await response.text()
        : "";
    if (!(response.status >= 400 && response.status < 500)) {
      await response.body?.cancel().catch(() => undefined);
    }
    return mapResponse(response.status, body.slice(0, 64 * 1024));
  } catch (error) {
    const timedOut =
      signal.aborted ||
      (error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError"));
    return {
      code: 451,
      enhanced: "4.3.0",
      message: TEMPORARY,
      webhookStatus: timedOut ? "timeout" : "network-error",
    };
  }
}
