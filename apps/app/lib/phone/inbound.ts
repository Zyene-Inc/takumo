import "server-only";

import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { track } from "../analytics";
import { featureProblem } from "../billing";
import { saveNote } from "../facts/notes";
import { shopVocabulary, transcribeAudio } from "../facts/transcribe";
import { fetchMedia, sendText } from "./client";
import {
  EMPTY_REPLY,
  type InboundText,
  OTHER_MEDIA_REPLY,
  type PhoneChannel,
  replyText,
} from "./twilio";

// A voice note or text sent to the shop number (F6.1): from a registered
// phone it becomes a note, read for facts like one left in the app, and the
// sender gets a one-line confirmation. Anything else is ignored: no reply and
// nothing stored (R4).

export interface PhoneAccepted {
  channel: PhoneChannel;
  messageId: string;
  orgId: string;
  phone: { id: string; name: string; phone: string; userId: string | null };
}

/**
 * The registered, confirmed phone a message came from, and the message
 * recorded once. Null: not a registered phone, or a retry of one we have.
 */
export const receivePhoneMessage = async (
  sender: { channel: PhoneChannel; phone: string },
  message: InboundText
): Promise<PhoneAccepted | null> => {
  // Looked up across shops: a confirmed number belongs to one shop.
  const phones = await database.phoneNumber.findMany({
    where: { phone: sender.phone, verifiedAt: { not: null } },
    select: { id: true, orgId: true, name: true, phone: true, userId: true },
  });
  if (phones.length !== 1) {
    return null;
  }
  const [phone] = phones as [(typeof phones)[number]];
  const existing = await database.phoneMessage.findUnique({
    where: { sid: message.sid },
    select: { id: true },
  });
  if (existing) {
    return null;
  }
  try {
    const saved = await forOrg(database, phone.orgId).phoneMessage.create({
      data: {
        orgId: phone.orgId,
        phoneId: phone.id,
        sid: message.sid,
        channel: sender.channel,
      },
      select: { id: true },
    });
    return {
      orgId: phone.orgId,
      messageId: saved.id,
      channel: sender.channel,
      phone,
    };
  } catch {
    // Twilio retried while the first delivery was being recorded.
    return null;
  }
};

const finish = (
  orgId: string,
  messageId: string,
  data: { status: string; noteId?: string; error?: string }
) =>
  forOrg(database, orgId).phoneMessage.updateMany({
    where: { id: messageId },
    data,
  });

/** The note's words: the voice note transcribed, plus any text with it. */
const noteText = async (orgId: string, message: InboundText) => {
  if (!message.media) {
    return { text: message.body, voice: false, durationSec: null };
  }
  const audio = await fetchMedia(message.media.url);
  const heard = await transcribeAudio(audio, await shopVocabulary(orgId));
  return {
    text: [heard.text, message.body].filter(Boolean).join("\n\n"),
    voice: true,
    durationSec: heard.durationSec,
  };
};

/** The slow half: read the note and reply. Never throws. */
export const processPhoneMessage = async (
  accepted: PhoneAccepted,
  message: InboundText
) => {
  const { orgId, messageId, channel, phone } = accepted;
  const reply = (body: string) => sendText({ to: phone.phone, channel, body });
  try {
    const blocked = await featureProblem(orgId, "knowledge");
    if (blocked) {
      await finish(orgId, messageId, { status: "failed", error: blocked });
      await reply(
        `Takumo can't take notes for your shop right now. ${blocked}`
      );
      return;
    }
    if (!(message.media || message.body) && message.hasOtherMedia) {
      await finish(orgId, messageId, {
        status: "failed",
        error: "Not a voice note or text.",
      });
      await reply(OTHER_MEDIA_REPLY);
      return;
    }
    const { text, voice, durationSec } = await noteText(orgId, message);
    if (text.trim().length < 3) {
      await finish(orgId, messageId, { status: "failed", error: "Empty." });
      await reply(EMPTY_REPLY);
      return;
    }
    // Someone with a Takumo login is credited by it; an operator on the
    // roster without one by their phone, so the fact isn't "by Takumo".
    const statedBy = phone.userId ?? `phone:${phone.id}`;
    const result = await saveNote(orgId, statedBy, {
      kind: voice ? "voice" : "typed",
      text,
      durationSec,
      source: voice ? "voice" : "note",
      channel,
      senderName: phone.name,
    });
    const note = await forOrg(database, orgId).note.findFirst({
      where: { id: result.noteId },
      select: { status: true },
    });
    const failed = note?.status === "failed";
    await finish(orgId, messageId, {
      status: failed ? "failed" : "processed",
      noteId: result.noteId,
    });
    await reply(
      replyText({ failed, proposed: result.proposed }) +
        (message.hasOtherMedia ? ` ${OTHER_MEDIA_REPLY}` : "")
    );
    track("note_saved", {
      orgId,
      userId: phone.userId,
      properties: {
        kind: voice ? "voice" : "typed",
        channel,
        facts: result.proposed.length,
      },
    });
  } catch (error) {
    log.error("Reading a text-message note failed", {
      orgId,
      error: String(error),
    });
    await finish(orgId, messageId, {
      status: "failed",
      error: "Takumo couldn't read this message.",
    });
    await reply(
      "Takumo couldn't read that just now. Try again in a few minutes, or leave the note in the app."
    ).catch(() => undefined);
  }
};
