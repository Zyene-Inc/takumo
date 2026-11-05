import { log } from "@repo/observability/log";
import { after } from "next/server";
import { env } from "@/env";
import { phoneConfigured } from "@/lib/phone/client";
import { processPhoneMessage, receivePhoneMessage } from "@/lib/phone/inbound";
import {
  EMPTY_TWIML,
  readInbound,
  senderOf,
  verifyTwilioSignature,
} from "@/lib/phone/twilio";

// Transcribing and reading a voice note can take a while after we answer.
export const maxDuration = 120;

const twiml = () =>
  new Response(EMPTY_TWIML, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });

/** The URL Twilio signed: as configured, else this route on the app's URL. */
const signedUrl = (request: Request) => {
  if (env.TWILIO_WEBHOOK_URL) {
    return env.TWILIO_WEBHOOK_URL;
  }
  const url = new URL(request.url);
  return `${env.NEXT_PUBLIC_APP_URL}${url.pathname}${url.search}`;
};

/**
 * Texts and WhatsApp messages to the shop number (F6.1), posted by Twilio.
 * Signed with the account's auth token; anything unsigned is refused. A
 * phone nobody registered gets an empty answer: no reply, nothing stored.
 */
export const POST = async (request: Request) => {
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!(authToken && phoneConfigured())) {
    return new Response("Text notes aren't set up.", { status: 503 });
  }
  const form = new URLSearchParams(await request.text());
  const params = [...form.entries()];
  const valid = verifyTwilioSignature({
    authToken,
    url: signedUrl(request),
    params,
    signature: request.headers.get("x-twilio-signature"),
  });
  if (!valid) {
    log.warn("Text message webhook rejected (bad signature)");
    return new Response("Bad signature.", { status: 403 });
  }
  const sender = senderOf(form.get("From"));
  const message = readInbound(new Map(params));
  if (!(sender && message)) {
    return twiml();
  }
  const accepted = await receivePhoneMessage(sender, message);
  if (accepted) {
    after(() => processPhoneMessage(accepted, message));
  }
  return twiml();
};
