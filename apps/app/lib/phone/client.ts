import "server-only";

import { log } from "@repo/observability/log";
import { env } from "@/env";
import type { PhoneChannel } from "./twilio";

// The shop number's Twilio account (F6.1). Unset: nothing is sent, only
// logged, and the phone settings page says text notes aren't set up.

const API = "https://api.twilio.com/2010-04-01";

/** Voice notes are capped like recordings uploaded in the app. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** Whether text notes can work at all (the webhook can be checked). */
export const phoneConfigured = () =>
  Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM
  );

/** The numbers people text, for the settings page. */
export const shopNumbers = () => ({
  sms: env.TWILIO_SMS_FROM ?? null,
  whatsapp: env.TWILIO_WHATSAPP_FROM ?? null,
});

const basicAuth = () =>
  `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`;

/** Send a text (or WhatsApp message); false when it couldn't be sent. */
export const sendText = async (input: {
  body: string;
  channel: PhoneChannel;
  to: string;
}) => {
  const sid = env.TWILIO_ACCOUNT_SID;
  const whatsappFrom = env.TWILIO_WHATSAPP_FROM;
  const from =
    input.channel === "whatsapp" && whatsappFrom
      ? `whatsapp:${whatsappFrom}`
      : env.TWILIO_SMS_FROM;
  if (!(sid && env.TWILIO_AUTH_TOKEN && from)) {
    log.info("Text message not sent (text notes aren't set up)", {
      channel: input.channel,
    });
    return false;
  }
  const to =
    input.channel === "whatsapp" && whatsappFrom
      ? `whatsapp:${input.to}`
      : input.to;
  try {
    const response = await fetch(`${API}/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: basicAuth(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: to, Body: input.body }),
    });
    if (!response.ok) {
      log.warn("Sending a text message failed", { status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    log.warn("Sending a text message failed", { error: String(error) });
    return false;
  }
};

/** A voice note's audio, from the URL in Twilio's webhook. */
export const fetchMedia = async (url: string) => {
  // Only Twilio's own media host gets the account's credentials.
  const host = new URL(url).hostname;
  if (!(host === "api.twilio.com" || host.endsWith(".twilio.com"))) {
    throw new Error("Media isn't on Twilio.");
  }
  const response = await fetch(url, {
    headers: { Authorization: basicAuth() },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Media download failed (${response.status}).`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_MEDIA_BYTES) {
    throw new Error("Voice note too large.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new Error("Voice note too large.");
  }
  return bytes;
};
