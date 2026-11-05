"use server";

import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/access";

// Time off (F3.1-R3): vacation, sick days and short days, which the plan and
// every "can we ship by …?" answer take into account.

/** Longest stretch entered at once (a long leave is several entries). */
const MAX_DAYS = 62;
const DAY_MS = 86_400_000;

const TimeOff = z
  .object({
    operatorId: z.string().min(1),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the first day."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the last day."),
    hours: z.coerce
      .number()
      .min(0, "Hours can't be negative.")
      .max(24, "A day has 24 hours."),
    reason: z.string().trim().max(80).optional(),
  })
  .refine((v) => v.to >= v.from, {
    message: "The last day is before the first.",
  });

type Result = { ok: true } | { ok: false; error: string };

export const addTimeOff = async (values: unknown): Promise<Result> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const parsed = TimeOff.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  }
  const v = parsed.data;
  const db = forOrg(database, access.orgId);
  const operator = await db.operator.findFirst({
    where: { id: v.operatorId },
    select: { id: true },
  });
  if (!operator) {
    return { ok: false, error: "That operator no longer exists." };
  }
  const first = Date.parse(`${v.from}T00:00:00Z`);
  const days = Math.round((Date.parse(`${v.to}T00:00:00Z`) - first) / DAY_MS);
  if (days + 1 > MAX_DAYS) {
    return {
      ok: false,
      error: `Enter at most ${MAX_DAYS} days at a time.`,
    };
  }
  for (let i = 0; i <= days; i += 1) {
    const date = new Date(first + i * DAY_MS);
    await database.operatorDay.upsert({
      where: { operatorId_date: { operatorId: operator.id, date } },
      create: {
        orgId: access.orgId,
        operatorId: operator.id,
        date,
        hours: v.hours,
        reason: v.reason || null,
      },
      update: { hours: v.hours, reason: v.reason || null },
    });
  }
  revalidatePath("/shop/operators");
  return { ok: true };
};

export const removeTimeOff = async (id: string): Promise<Result> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const { count } = await forOrg(database, access.orgId).operatorDay.deleteMany(
    { where: { id } }
  );
  revalidatePath("/shop/operators");
  return count ? { ok: true } : { ok: false, error: "Not found." };
};
