"use server";

import { auth } from "@repo/auth/server";
import { database } from "@repo/database";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ALERT_TYPES } from "@/lib/alerts/detect";
import { SECTIONS } from "@/lib/brief/content";
import { isClock, isTimeZone } from "@/lib/brief/timing";

const Prefs = z.object({
  briefOn: z.boolean(),
  briefTime: z.string().refine(isClock, "Pick a time like 06:30."),
  timeZone: z.string().refine(isTimeZone, "Pick a time zone from the list."),
  briefOff: z.array(z.enum(SECTIONS)),
  alertsOff: z.array(z.enum(ALERT_TYPES)),
});

export type PrefsForm = z.infer<typeof Prefs>;

/** Your own brief and alert settings (anyone in the shop, for themselves). */
export const saveNotifyPrefs = async (
  input: PrefsForm
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const { orgId, userId } = await auth();
  if (!(orgId && userId)) {
    return { ok: false, error: "Sign in again." };
  }
  const parsed = Prefs.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  }
  const data = {
    ...parsed.data,
    briefOff: [...new Set(parsed.data.briefOff)],
    alertsOff: [...new Set(parsed.data.alertsOff)],
  };
  await database.notifyPrefs.upsert({
    where: { orgId_userId: { orgId, userId } },
    create: { orgId, userId, ...data },
    update: data,
  });
  revalidatePath("/settings/notifications");
  return { ok: true };
};
