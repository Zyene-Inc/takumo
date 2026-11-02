import { log } from "@repo/observability/log";
import { after } from "next/server";
import { env } from "@/env";
import { processMessage, receiveMessage } from "@/lib/inbound/process";
import { parseAuth, verifySignature } from "@/lib/inbound/verify";

// ERP reports and big scans: reading them can take a while after we answer.
export const maxDuration = 300;

// What services/mail accepts for one message (it enforces the same limit).
const MAX_BYTES = 25 * 1024 * 1024;

const reply = (status: number, error?: string) =>
  Response.json(error ? { error } : { ok: true }, { status });

/**
 * Mail for a shop's Takumo addresses, delivered by our mail receiver
 * (services/mail) as a signed webhook. 2xx tells it to accept the message,
 * 4xx to bounce it (the error text goes back to the sender), 5xx to have the
 * sender retry later.
 */
export const POST = async (request: Request) => {
  const secret = env.INBOUND_EMAIL_SECRET;
  if (!secret) {
    return reply(503, "Inbound email isn't set up.");
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) {
    return reply(413, "Message too large.");
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BYTES) {
    return reply(413, "Message too large.");
  }
  const recipients = request.headers.get("x-takumo-recipients") ?? "";
  const mailFrom = request.headers.get("x-takumo-mail-from") ?? "";
  const checked = verifySignature({
    secret,
    timestamp: request.headers.get("x-takumo-timestamp"),
    signature: request.headers.get("x-takumo-signature"),
    recipients,
    mailFrom,
    body: raw,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!checked.ok) {
    log.warn("Inbound email rejected", { reason: checked.error });
    return reply(401, checked.error);
  }

  const result = await receiveMessage({
    raw,
    mailFrom,
    recipients: recipients.split(",").filter(Boolean),
    auth: parseAuth(request.headers.get("x-takumo-auth")),
  });
  if (!result.ok) {
    return reply(result.status, result.error);
  }
  for (const accepted of result.accepted) {
    after(() => processMessage(accepted, raw));
  }
  return reply(200);
};
