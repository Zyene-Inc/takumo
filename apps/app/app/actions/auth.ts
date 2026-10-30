"use server";

import {
  createOrganizationForUser,
  listUserOrganizations,
  signOut,
  switchToOrganization,
  withAuth,
} from "@repo/auth/server";
import { database } from "@repo/database";
import {
  DEMO_DOCS,
  demoShiftDays,
  seedDemoShop,
} from "@repo/database/demo/seed";
import { trialEndsAt } from "@repo/payments/plans";
import { env } from "@/env";
import { track } from "@/lib/analytics";
import { saveDocument } from "@/lib/knowledge/documents";

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
    create: { id: organization.id, name, trialEndsAt: trialEndsAt() },
    update: { name },
  });
  await database.member.upsert({
    where: { orgId_userId: { orgId: organization.id, userId: user.id } },
    create: { orgId: organization.id, userId: user.id, role: "owner" },
    update: {},
  });

  await switchToOrganization(organization.id, { returnTo: "/onboarding" });
};

const DEMO_NAME = "Acme Precision (demo)";

/**
 * A separate shop filled with the demo data (dates moved to now), to try
 * Takumo without touching a real shop.
 */
export const createDemoShop = async () => {
  const { user } = await withAuth({ ensureSignedIn: true });
  const organization = await createOrganizationForUser(DEMO_NAME, user.id);
  await database.org.upsert({
    where: { id: organization.id },
    create: {
      id: organization.id,
      name: DEMO_NAME,
      trialEndsAt: trialEndsAt(),
    },
    update: {},
  });
  await database.member.upsert({
    where: { orgId_userId: { orgId: organization.id, userId: user.id } },
    create: { orgId: organization.id, userId: user.id, role: "owner" },
    update: {},
  });
  await seedDemoShop(database, organization.id, {
    shiftDays: demoShiftDays(new Date().toISOString().slice(0, 10)),
  });
  for (const [file, text] of Object.entries(DEMO_DOCS)) {
    await saveDocument(organization.id, file, [{ page: 1, text }]);
  }
  track("demo_shop_created", { orgId: organization.id, userId: user.id });
  await switchToOrganization(organization.id, { returnTo: "/" });
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
