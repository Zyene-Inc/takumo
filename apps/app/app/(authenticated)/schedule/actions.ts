"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/access";
import { track } from "@/lib/analytics";
import { replan } from "@/lib/schedule/plan";
import { checkToday, ISO_DAY } from "@/lib/schedule/request";

export type BoardActionResult =
  | { ok: true }
  | { ok: false; error: string; conflicts?: string[] };

const BAD_DATE =
  "Your computer's date looks wrong; reload the page and try again.";

const refresh = () => {
  revalidatePath("/schedule");
  revalidatePath("/schedule/bottlenecks");
};

/** Re-plan the shop from today. */
export const replanShop = async (today: string): Promise<BoardActionResult> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const start = checkToday(today);
  if (!start) {
    return { ok: false, error: BAD_DATE };
  }
  const { userId } = await auth();
  const result = await replan(access.orgId, userId, start);
  track("plan_built", {
    orgId: access.orgId,
    userId,
    properties: { ok: result.ok },
  });
  if (result.ok) {
    refresh();
    return { ok: true };
  }
  return { ok: false, error: result.error, conflicts: result.conflicts };
};

interface MoveInput {
  orderNo: string;
  seq: number;
  startDate: string;
  today: string;
  workCenter: string;
}

/**
 * The planner dragged an operation: pin it to that machine and day, then
 * re-plan everything else around it. If the pin can't be honoured, nothing
 * changes and the reason comes back.
 */
export const moveOperation = async (
  input: MoveInput
): Promise<BoardActionResult> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const start = checkToday(input.today);
  if (!start) {
    return { ok: false, error: BAD_DATE };
  }
  if (!ISO_DAY.test(input.startDate) || input.startDate < start) {
    return {
      ok: false,
      error: "Operations can only be moved to today or later.",
    };
  }
  const db = forOrg(database, access.orgId);
  const [order, machine] = await Promise.all([
    db.order.findFirst({
      where: {
        orderNo: input.orderNo,
        status: { in: ["open", "in_progress"] },
      },
      select: {
        id: true,
        part: {
          select: {
            routings: {
              where: { seq: input.seq },
              select: { workCenterId: true, altWorkCenterIds: true },
            },
          },
        },
      },
    }),
    db.workCenter.findFirst({
      where: { name: input.workCenter },
      select: { id: true },
    }),
  ]);
  const routing = order?.part.routings[0];
  if (!(order && routing && machine)) {
    return {
      ok: false,
      error: "That operation or machine no longer exists. Reload the board.",
    };
  }
  if (
    routing.workCenterId !== machine.id &&
    !routing.altWorkCenterIds.includes(machine.id)
  ) {
    return {
      ok: false,
      error: `${input.orderNo} op ${input.seq} can't run on ${input.workCenter}. Add it as an alternate machine on the part's routing first.`,
    };
  }

  const key = {
    orderId_routingSeq: { orderId: order.id, routingSeq: input.seq },
  };
  const previous = await database.job.findUnique({ where: key });
  await database.job.upsert({
    where: key,
    create: {
      orgId: access.orgId,
      orderId: order.id,
      routingSeq: input.seq,
      workCenterId: machine.id,
      plannedStart: new Date(`${input.startDate}T00:00:00Z`),
      pinned: true,
    },
    update: {
      workCenterId: machine.id,
      plannedStart: new Date(`${input.startDate}T00:00:00Z`),
      pinned: true,
    },
  });

  const { userId } = await auth();
  const result = await replan(access.orgId, userId, start);
  if (result.ok) {
    refresh();
    return { ok: true };
  }

  // Put the job back the way it was.
  if (previous) {
    await database.job.update({
      where: key,
      data: {
        workCenterId: previous.workCenterId,
        plannedStart: previous.plannedStart,
        pinned: previous.pinned,
      },
    });
  } else {
    await database.job.delete({ where: key });
  }
  return {
    ok: false,
    error: `Can't start ${input.orderNo} op ${input.seq} on ${input.workCenter} on ${input.startDate}. ${result.error}`,
    conflicts: result.conflicts,
  };
};

/** Let the scheduler place this operation again. */
export const unpinOperation = async (input: {
  orderNo: string;
  seq: number;
  today: string;
}): Promise<BoardActionResult> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const start = checkToday(input.today);
  if (!start) {
    return { ok: false, error: BAD_DATE };
  }
  await forOrg(database, access.orgId).job.updateMany({
    where: { routingSeq: input.seq, order: { orderNo: input.orderNo } },
    data: { pinned: false },
  });
  const { userId } = await auth();
  const result = await replan(access.orgId, userId, start);
  refresh();
  return result.ok ? { ok: true } : { ok: false, error: result.error };
};

/** Unpin everything and re-plan from scratch. */
export const clearPins = async (today: string): Promise<BoardActionResult> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const start = checkToday(today);
  if (!start) {
    return { ok: false, error: BAD_DATE };
  }
  await forOrg(database, access.orgId).job.updateMany({
    where: { pinned: true },
    data: { pinned: false },
  });
  const { userId } = await auth();
  const result = await replan(access.orgId, userId, start);
  refresh();
  return result.ok ? { ok: true } : { ok: false, error: result.error };
};
