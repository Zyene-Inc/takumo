import "server-only";

import { database, forOrg } from "@repo/database";
import { phoneConfigured, sendText } from "./client";
import {
  CODE_RESEND_MS,
  CODE_TTL_MS,
  checkCode,
  codeMessage,
  hashCode,
  newCode,
} from "./twilio";

// Registering a phone for notes by text (F6.1-R1): someone adds the number
// in the app, Takumo texts it a code, and the code typed back in the app
// confirms it. Only confirmed phones are listened to.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const NOT_SET_UP =
  "Text notes aren't set up on this Takumo yet: there's no shop number to text.";

/** Text a new code to a registration; refuses a second one within a minute. */
export const sendCode = async (
  orgId: string,
  id: string,
  now = new Date()
): Promise<Result> => {
  if (!phoneConfigured()) {
    return { ok: false, error: NOT_SET_UP };
  }
  const db = forOrg(database, orgId);
  const entry = await db.phoneNumber.findFirst({ where: { id } });
  if (!entry) {
    return { ok: false, error: "That phone isn't registered any more." };
  }
  if (entry.verifiedAt) {
    return { ok: false, error: "That phone is already confirmed." };
  }
  if (
    entry.codeSentAt &&
    now.getTime() - entry.codeSentAt.getTime() < CODE_RESEND_MS
  ) {
    return { ok: false, error: "A code was just sent. Wait a minute." };
  }
  const code = newCode();
  await db.phoneNumber.updateMany({
    where: { id },
    data: {
      codeHash: hashCode(id, code),
      codeSentAt: now,
      codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS),
      attempts: 0,
    },
  });
  const sent = await sendText({
    to: entry.phone,
    channel: "sms",
    body: codeMessage(code),
  });
  return sent
    ? { ok: true }
    : { ok: false, error: "The code couldn't be sent. Check the number." };
};

/** Add a phone (or reuse an unconfirmed one) and text it a code. */
export const registerPhone = async (
  orgId: string,
  input: {
    addedBy: string | null;
    name: string;
    operatorId?: string | null;
    phone: string;
    userId?: string | null;
  }
): Promise<Result<{ id: string }>> => {
  if (!phoneConfigured()) {
    return { ok: false, error: NOT_SET_UP };
  }
  const db = forOrg(database, orgId);
  const existing = await db.phoneNumber.findFirst({
    where: { phone: input.phone },
  });
  if (existing?.verifiedAt) {
    return { ok: false, error: "That phone is already registered." };
  }
  const data = {
    name: input.name,
    userId: input.userId ?? null,
    operatorId: input.operatorId ?? null,
    addedBy: input.addedBy,
  };
  const entry = existing
    ? await db.phoneNumber.update({ where: { id: existing.id }, data })
    : await db.phoneNumber.create({
        data: { orgId, phone: input.phone, ...data },
      });
  const sent = await sendCode(orgId, entry.id);
  return sent.ok ? { ok: true, id: entry.id } : sent;
};

/** Confirm a phone with the code it was sent. */
export const confirmPhone = async (
  orgId: string,
  id: string,
  code: string,
  now = new Date()
): Promise<Result> => {
  const db = forOrg(database, orgId);
  const entry = await db.phoneNumber.findFirst({ where: { id } });
  if (!entry) {
    return { ok: false, error: "That phone isn't registered any more." };
  }
  if (entry.verifiedAt) {
    return { ok: true };
  }
  const checked = checkCode(entry, code, now);
  if (!checked.ok) {
    if (!checked.spent) {
      await db.phoneNumber.updateMany({
        where: { id },
        data: { attempts: { increment: 1 } },
      });
    }
    return { ok: false, error: checked.error };
  }
  // A phone sends to one shop: messages are routed by the number alone.
  const elsewhere = await database.phoneNumber.findFirst({
    where: { phone: entry.phone, verifiedAt: { not: null }, NOT: { id } },
    select: { id: true },
  });
  if (elsewhere) {
    return {
      ok: false,
      error:
        "That phone already sends notes to another shop on Takumo. Remove it there first.",
    };
  }
  await db.phoneNumber.updateMany({
    where: { id },
    data: {
      verifiedAt: now,
      codeHash: null,
      codeExpiresAt: null,
      attempts: 0,
    },
  });
  await sendText({
    to: entry.phone,
    channel: "sms",
    body: "This phone is confirmed. Send Takumo a voice note or a text about a job any time; your supervisor reviews what it finds.",
  });
  return { ok: true };
};
