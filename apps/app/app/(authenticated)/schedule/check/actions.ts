"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { type CapacityResponse, SOLVED_STATUSES } from "@repo/engine-client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/access";
import { type CapacityAnswer, runCapacityCheck } from "@/lib/schedule/check";
import { CAPACITY_CHECK, type CheckInput, replan } from "@/lib/schedule/plan";
import { checkToday } from "@/lib/schedule/request";

const optionalNumber = z
  .union([z.literal(""), z.coerce.number().min(0)])
  .transform((v) => (v === "" ? null : v));

const CheckForm = z.object({
  partId: z.string().min(1, "Choose a part."),
  qty: z.coerce
    .number()
    .int("Quantity must be a whole number.")
    .positive("Quantity must be more than 0."),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a due date."),
  customer: z.string().trim().max(200).optional().default(""),
  orderNo: z.string().trim().max(60).optional().default(""),
  price: optionalNumber,
  materialCost: optionalNumber,
  today: z.string(),
});

export type CheckFormValues = z.input<typeof CheckForm>;

export type CheckResult = CapacityAnswer;

/** "Can we take this order?" Anyone in the shop can ask; nothing is saved to the plan. */
export const checkOrder = async (
  values: CheckFormValues
): Promise<CheckResult> => {
  const { orgId, userId } = await auth();
  if (!orgId) {
    return { ok: false, error: "Choose a shop first." };
  }
  const parsed = CheckForm.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  }
  const form = parsed.data;
  const start = checkToday(form.today);
  if (!start) {
    return {
      ok: false,
      error: "Your computer's date looks wrong; reload and try again.",
    };
  }
  const answer = await runCapacityCheck(orgId, userId, start, form);
  if (answer.ok) {
    revalidatePath("/schedule/check");
  }
  return answer;
};

/** "Add to plan": create the order and re-plan. `rush` puts it first. */
export const addToPlan = async (input: {
  runId: string;
  rush: boolean;
  today: string;
}): Promise<{ ok: true; orderNo: string } | { ok: false; error: string }> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const start = checkToday(input.today);
  if (!start) {
    return {
      ok: false,
      error: "Your computer's date looks wrong; reload and try again.",
    };
  }
  const db = forOrg(database, access.orgId);
  const run = await db.scheduleRun.findFirst({
    where: { id: input.runId, objective: CAPACITY_CHECK },
  });
  if (!run) {
    return { ok: false, error: "That check no longer exists." };
  }
  const check = run.input as unknown as CheckInput;
  const output = run.output as unknown as CapacityResponse;
  if (check.addedOrderNo) {
    return { ok: false, error: `Already added as ${check.addedOrderNo}.` };
  }
  if (!SOLVED_STATUSES.includes(output.status)) {
    return {
      ok: false,
      error: "This check didn't produce an answer; run it again.",
    };
  }
  if (
    await db.order.findFirst({
      where: { orderNo: check.orderNo },
      select: { id: true },
    })
  ) {
    return { ok: false, error: `Order ${check.orderNo} already exists.` };
  }

  const customer = check.customer
    ? await database.customer.upsert({
        where: { orgId_name: { orgId: access.orgId, name: check.customer } },
        create: { orgId: access.orgId, name: check.customer },
        update: {},
        select: { id: true },
      })
    : null;
  await db.order.create({
    data: {
      orgId: access.orgId,
      orderNo: check.orderNo,
      partId: check.partId,
      qty: check.qty,
      dueDate: new Date(`${check.dueDate}T00:00:00Z`),
      price: check.price,
      priority: input.rush ? 10 : 0,
      customerId: customer?.id ?? null,
      status: "open",
    },
  });
  await db.scheduleRun.updateMany({
    where: { id: run.id },
    data: { input: { ...check, addedOrderNo: check.orderNo } as object },
  });

  const { userId } = await auth();
  const result = await replan(access.orgId, userId, start);
  revalidatePath("/schedule");
  revalidatePath("/schedule/check");
  revalidatePath("/shop/orders");
  if (!result.ok) {
    return {
      ok: false,
      error: `Added ${check.orderNo}, but re-planning failed: ${result.error}`,
    };
  }
  return { ok: true, orderNo: check.orderNo };
};

/** The planner's judgment on an answer: Phase 2 is done when 10 real cases agree. */
export const recordVerdict = async (input: {
  runId: string;
  verdict: "agree" | "disagree";
  note: string;
}): Promise<{ ok: true } | { ok: false; error: string }> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  if (input.verdict !== "agree" && input.verdict !== "disagree") {
    return { ok: false, error: "Choose agree or disagree." };
  }
  const { userId } = await auth();
  const { count } = await forOrg(database, access.orgId).scheduleRun.updateMany(
    {
      where: { id: input.runId, objective: CAPACITY_CHECK },
      data: {
        verdict: input.verdict,
        verdictNote: input.note.trim().slice(0, 2000) || null,
        verdictBy: userId,
      },
    }
  );
  if (count === 0) {
    return { ok: false, error: "That check no longer exists." };
  }
  revalidatePath("/schedule/check");
  return { ok: true };
};
