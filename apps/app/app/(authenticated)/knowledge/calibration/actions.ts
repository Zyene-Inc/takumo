"use server";

import { auth } from "@repo/auth/server";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/access";
import { type RecalibrationResult, recalibrate } from "@/lib/facts/recalibrate";

/** Compare finished jobs with the routings now, instead of waiting for tonight. */
export const recalibrateNow = async (): Promise<
  ({ ok: true } & RecalibrationResult) | { ok: false; error: string }
> => {
  const access = await authorize("knowledge:review");
  if (!access.ok) {
    return access;
  }
  const { userId } = await auth();
  const result = await recalibrate(access.orgId, new Date(), userId);
  revalidatePath("/knowledge/calibration");
  revalidatePath("/knowledge/facts");
  return { ok: true, ...result };
};
