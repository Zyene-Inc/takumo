"use server";

import { database } from "@repo/database";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";

const DAY_MS = 86_400_000;
const MAX_EXTENSION_DAYS = 180;

/** Design partners: give a shop's trial more days (from today or its end, whichever is later). */
export const extendTrial = async (
  orgId: string,
  days: number
): Promise<{ ok: true } | { ok: false; error: string }> => {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Not allowed." };
  }
  if (!(Number.isInteger(days) && days > 0 && days <= MAX_EXTENSION_DAYS)) {
    return { ok: false, error: `1 to ${MAX_EXTENSION_DAYS} days.` };
  }
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: { plan: true, trialEndsAt: true },
  });
  if (!org) {
    return { ok: false, error: "No such shop." };
  }
  if (org.plan !== "trial") {
    return { ok: false, error: "This shop is on a paid plan." };
  }
  const from = Math.max(Date.now(), org.trialEndsAt?.getTime() ?? 0);
  await database.org.update({
    where: { id: orgId },
    data: { trialEndsAt: new Date(from + days * DAY_MS) },
  });
  revalidatePath("/admin");
  return { ok: true };
};

/**
 * Turn a shop's Company Knowledge Library on or off. Never sets
 * "confidential" (restricted access isn't available yet), and a shop that is
 * already confidential can't be switched back here, so restricted documents
 * can't become visible by accident.
 */
export const setLibrary = async (
  orgId: string,
  on: boolean
): Promise<{ ok: true } | { ok: false; error: string }> => {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Not allowed." };
  }
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: { libraryStage: true },
  });
  if (!org) {
    return { ok: false, error: "No such shop." };
  }
  if (org.libraryStage === "confidential") {
    return {
      ok: false,
      error: "This shop restricts documents; change it by hand.",
    };
  }
  await database.org.update({
    where: { id: orgId },
    data: { libraryStage: on ? "library" : "off" },
  });
  revalidatePath("/admin");
  return { ok: true };
};
