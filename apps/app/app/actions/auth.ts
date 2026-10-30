"use server";

import {
  createOrganizationForUser,
  listUserOrganizations,
  signOut,
  switchToOrganization,
  withAuth,
} from "@repo/auth/server";
import { database } from "@repo/database";
import { env } from "@/env";

const MAX_SHOP_NAME_LENGTH = 80;

/** Creates a shop (WorkOS organization), mirrors it locally, and enters it. */
export const createShop = async (formData: FormData) => {
  const name = String(formData.get("name") ?? "")
    .trim()
    .slice(0, MAX_SHOP_NAME_LENGTH);

  if (!name) {
    return;
  }

  const { user } = await withAuth({ ensureSignedIn: true });
  const organization = await createOrganizationForUser(name, user.id);

  await database.org.upsert({
    where: { id: organization.id },
    create: { id: organization.id, name },
    update: { name },
  });
  await database.member.upsert({
    where: { orgId_userId: { orgId: organization.id, userId: user.id } },
    create: { orgId: organization.id, userId: user.id, role: "owner" },
    update: {},
  });

  await switchToOrganization(organization.id, { returnTo: "/onboarding" });
};

/** Switches the session to another shop the user belongs to. */
export const switchShop = async (organizationId: string) => {
  const { user } = await withAuth({ ensureSignedIn: true });
  const organizations = await listUserOrganizations(user.id);

  if (!organizations.some((org) => org.id === organizationId)) {
    throw new Error("You are not a member of that shop");
  }

  await switchToOrganization(organizationId, { returnTo: "/" });
};

export const signOutAction = async () => {
  await signOut({ returnTo: env.NEXT_PUBLIC_WEB_URL });
};
