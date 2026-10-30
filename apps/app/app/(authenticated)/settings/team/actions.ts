"use server";

import {
  auth,
  inviteToShop,
  listShopInvitations,
  listShopMembers,
  revokeShopInvitation,
} from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/access";
import { getBilling } from "@/lib/billing";
import { INVITE_ROLES } from "./roles";

type Result = { ok: true } | { ok: false; error: string };

const Invite = z.object({
  email: z.email("Enter an email address."),
  role: z.enum(INVITE_ROLES),
});

/** Invite someone to the shop; the Shop plan includes 5 users. */
export const invite = async (
  values: z.input<typeof Invite>
): Promise<Result> => {
  const access = await authorize("billing:manage");
  if (!access.ok) {
    return {
      ok: false,
      error: "Only the shop's owner or an admin can invite people.",
    };
  }
  const parsed = Invite.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  }
  const [{ entitlements }, members, invitations] = await Promise.all([
    getBilling(access.orgId),
    listShopMembers(access.orgId),
    listShopInvitations(access.orgId),
  ]);
  const email = parsed.data.email.toLowerCase();
  if (members.some((m) => m.email.toLowerCase() === email)) {
    return { ok: false, error: `${email} is already in this shop.` };
  }
  if (invitations.some((i) => i.email.toLowerCase() === email)) {
    return { ok: false, error: `${email} already has an invitation.` };
  }
  if (
    entitlements.seats !== null &&
    members.length + invitations.length >= entitlements.seats
  ) {
    return {
      ok: false,
      error: `The ${entitlements.plan.name} plan includes ${entitlements.seats} users. Upgrade to Pro for unlimited users.`,
    };
  }
  const { userId } = await auth();
  try {
    await inviteToShop(access.orgId, email, parsed.data.role, userId ?? "");
  } catch (error) {
    log.warn("Invitation failed", { error: String(error) });
    return {
      ok: false,
      error:
        "WorkOS couldn't send the invitation. Check the address and try again.",
    };
  }
  revalidatePath("/settings/team");
  return { ok: true };
};

export const revoke = async (invitationId: string): Promise<Result> => {
  const access = await authorize("billing:manage");
  if (!access.ok) {
    return {
      ok: false,
      error: "Only the shop's owner or an admin can do that.",
    };
  }
  const invitations = await listShopInvitations(access.orgId);
  if (!invitations.some((i) => i.id === invitationId)) {
    return { ok: false, error: "That invitation is gone." };
  }
  await revokeShopInvitation(invitationId);
  revalidatePath("/settings/team");
  return { ok: true };
};
