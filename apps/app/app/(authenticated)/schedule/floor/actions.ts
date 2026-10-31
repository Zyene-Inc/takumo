"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/access";
import { track } from "@/lib/analytics";
import { featureProblem } from "@/lib/billing";
import { saveNote } from "@/lib/facts/notes";
import { clearLog, logOperation } from "@/lib/floor/log";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const Log = z.object({
  orderId: z.string().min(1),
  seq: z.number().int().positive(),
  setupMin: z.coerce.number().min(0, "Setup time can't be negative."),
  runMin: z.coerce.number().min(0, "Run time can't be negative."),
  qtyGood: z.coerce.number().int().min(0),
  qtyScrap: z.coerce.number().int().min(0),
  // Shop-local time from the browser (no zone), stored like planned times.
  finishedAt: z.string().regex(LOCAL_TIME, "Enter when it finished."),
  note: z.string().trim().max(4000),
});

export type LogValues = z.input<typeof Log>;

const refresh = () => {
  revalidatePath("/schedule/floor");
  revalidatePath("/schedule");
  revalidatePath("/knowledge/calibration");
  revalidatePath("/shop/orders");
};

export const logOp = async (
  values: LogValues
): Promise<
  Result<{ orderDone: boolean; orderNo: string; facts: string[] }>
> => {
  const access = await authorize("floor:write");
  if (!access.ok) {
    return access;
  }
  const parsed = Log.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  }
  const { userId } = await auth();
  const v = parsed.data;
  const logged = await logOperation(access.orgId, userId, {
    orderId: v.orderId,
    seq: v.seq,
    setupMin: v.setupMin,
    runMin: v.runMin,
    qtyGood: v.qtyGood,
    qtyScrap: v.qtyScrap,
    finishedAt: new Date(`${v.finishedAt}:00Z`),
  });
  if (!logged.ok) {
    return logged;
  }
  track("job_logged", {
    orgId: access.orgId,
    userId,
    properties: { order_done: logged.orderDone },
  });
  let facts: string[] = [];
  // Reading the note uses Claude; without the plan or budget it waits for a retry.
  const paused =
    v.note.length >= 3 ? await featureProblem(access.orgId, "knowledge") : null;
  if (v.note.length >= 3) {
    const job = await forOrg(database, access.orgId).job.findFirst({
      where: { orderId: v.orderId, routingSeq: v.seq },
      select: { id: true },
    });
    facts = (
      await saveNote(access.orgId, userId, {
        kind: "typed",
        text: `${logged.orderNo} op ${v.seq}: ${v.note}`,
        jobId: job?.id ?? null,
        source: "floor",
        paused,
      })
    ).proposed;
  }
  refresh();
  return {
    ok: true,
    orderNo: logged.orderNo,
    orderDone: logged.orderDone,
    facts,
  };
};

export const undoLog = async (jobId: string): Promise<Result> => {
  const access = await authorize("floor:write");
  if (!access.ok) {
    return access;
  }
  const result = await clearLog(access.orgId, jobId);
  refresh();
  return result.ok ? { ok: true } : result;
};
