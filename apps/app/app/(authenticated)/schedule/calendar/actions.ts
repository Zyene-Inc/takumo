"use server";

import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/access";

const MAX_DAYS = 120;
const MAX_ROWS = 2000;

const AddDays = z
  .object({
    workCenterId: z.string().min(1, "Choose a machine."),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a start date."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose an end date."),
    hours: z.coerce
      .number()
      .min(0, "Hours can't be negative.")
      .max(24, "A day has 24 hours."),
    reason: z.string().trim().max(120).optional().default(""),
  })
  .refine((v) => v.to >= v.from, {
    message: "The end date is before the start date.",
  });

type CalendarResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

/** Holidays, maintenance or extra shifts for one machine or all ("all"). */
export const addCalendarDays = async (
  values: z.input<typeof AddDays>
): Promise<CalendarResult> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const parsed = AddDays.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  }
  const { workCenterId, from, to, hours, reason } = parsed.data;
  const db = forOrg(database, access.orgId);
  const machines = await db.workCenter.findMany({
    where: workCenterId === "all" ? {} : { id: workCenterId },
    select: { id: true },
  });
  if (machines.length === 0) {
    return { ok: false, error: "That machine no longer exists." };
  }

  const dates: Date[] = [];
  for (
    let day = new Date(`${from}T00:00:00Z`);
    day <= new Date(`${to}T00:00:00Z`);
    day = new Date(day.getTime() + 86_400_000)
  ) {
    dates.push(day);
  }
  if (dates.length > MAX_DAYS) {
    return { ok: false, error: `Add at most ${MAX_DAYS} days at a time.` };
  }
  if (dates.length * machines.length > MAX_ROWS) {
    return {
      ok: false,
      error: "That's a lot of days for every machine; add a shorter range.",
    };
  }

  await database.$transaction(
    machines.flatMap((m) =>
      dates.map((date) =>
        database.calendarDay.upsert({
          where: { workCenterId_date: { workCenterId: m.id, date } },
          create: {
            orgId: access.orgId,
            workCenterId: m.id,
            date,
            availableHours: hours,
            reason: reason || null,
          },
          update: { availableHours: hours, reason: reason || null },
        })
      )
    )
  );
  revalidatePath("/schedule/calendar");
  revalidatePath("/schedule");
  return { ok: true, count: machines.length * dates.length };
};

export const removeCalendarDays = async (
  ids: string[]
): Promise<CalendarResult> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const { count } = await forOrg(database, access.orgId).calendarDay.deleteMany(
    {
      where: { id: { in: ids.slice(0, 1000) } },
    }
  );
  revalidatePath("/schedule/calendar");
  revalidatePath("/schedule");
  return { ok: true, count };
};
