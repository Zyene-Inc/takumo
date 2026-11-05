"use server";

import { can } from "@repo/auth/permissions";
import { auth, currentUser, listShopMembers } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { confirmPhone, registerPhone, sendCode } from "@/lib/phone/register";
import { normalizePhone } from "@/lib/phone/twilio";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const PATH = "/settings/integrations/phone";
const SIX_DIGITS = /^\d{6}$/;

/**
 * Who's acting: anyone in the shop can register their own phone; the owner
 * or an admin can register anyone's (an operator without a Takumo login).
 */
const actor = async () => {
  const { orgId, userId, role } = await auth();
  if (!(orgId && userId)) {
    return null;
  }
  return { orgId, userId, admin: can(role, "connectors:manage") };
};

/** Whether this actor may change this registration. */
const mayChange = async (
  who: NonNullable<Awaited<ReturnType<typeof actor>>>,
  id: string
) => {
  const entry = await forOrg(database, who.orgId).phoneNumber.findFirst({
    where: { id },
    select: { userId: true, addedBy: true },
  });
  if (!entry) {
    return false;
  }
  return who.admin || entry.userId === who.userId;
};

const addSchema = z.object({
  phone: z.string().max(40),
  // "me", "operator:<id>", "member:<userId>" or "name"
  who: z.string().max(200),
  name: z.string().max(120).optional(),
});

export const addPhone = async (
  input: z.infer<typeof addSchema>
): Promise<Result> => {
  const who = await actor();
  if (!who) {
    return { ok: false, error: "Choose a shop first." };
  }
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Check the phone number." };
  }
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    return {
      ok: false,
      error:
        "That isn't a phone number Takumo can text. Use the full number, with + and the country code outside the US.",
    };
  }
  const choice = parsed.data.who;
  let person: { name: string; userId?: string; operatorId?: string } | null =
    null;
  if (choice === "me") {
    const user = await currentUser();
    person = {
      name:
        [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
        user?.email ||
        "Me",
      userId: who.userId,
    };
  } else if (!who.admin) {
    return {
      ok: false,
      error:
        "You can register your own phone. The shop's owner or an admin can register someone else's.",
    };
  } else if (choice.startsWith("operator:")) {
    const operator = await forOrg(database, who.orgId).operator.findFirst({
      where: { id: choice.slice("operator:".length) },
      select: { id: true, name: true },
    });
    person = operator ? { name: operator.name, operatorId: operator.id } : null;
  } else if (choice.startsWith("member:")) {
    const member = (await listShopMembers(who.orgId)).find(
      (m) => m.userId === choice.slice("member:".length)
    );
    person = member ? { name: member.name, userId: member.userId } : null;
  } else if (choice === "name" && parsed.data.name?.trim()) {
    person = { name: parsed.data.name.trim() };
  }
  if (!person) {
    return { ok: false, error: "Choose whose phone it is." };
  }
  const result = await registerPhone(who.orgId, {
    phone,
    addedBy: who.userId,
    ...person,
  });
  revalidatePath(PATH);
  return result.ok ? { ok: true } : result;
};

export const resendCode = async (id: string): Promise<Result> => {
  const who = await actor();
  if (!(who && (await mayChange(who, id)))) {
    return { ok: false, error: "You can't change that phone." };
  }
  const result = await sendCode(who.orgId, id);
  revalidatePath(PATH);
  return result;
};

export const confirmCode = async (
  id: string,
  code: string
): Promise<Result> => {
  const who = await actor();
  if (!(who && (await mayChange(who, id)))) {
    return { ok: false, error: "You can't change that phone." };
  }
  if (!SIX_DIGITS.test(code.trim())) {
    return { ok: false, error: "The code is 6 digits." };
  }
  const result = await confirmPhone(who.orgId, id, code);
  revalidatePath(PATH);
  return result;
};

export const removePhone = async (id: string): Promise<Result> => {
  const who = await actor();
  if (!(who && (await mayChange(who, id)))) {
    return { ok: false, error: "You can't change that phone." };
  }
  await forOrg(database, who.orgId).phoneNumber.deleteMany({ where: { id } });
  revalidatePath(PATH);
  return { ok: true };
};
