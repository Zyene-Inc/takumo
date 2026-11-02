"use server";

import { database, forOrg, Prisma } from "@repo/database";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/access";

// Fields Takumo owns even on records the ERP sends (docs/PRODUCT-PLAN.md
// F1.4, F2.4-R4, F3.1-R6): an ERP report never carries them, so they're
// editable on ERP-synced records too.

type Result = { ok: true } | { ok: false; error: string };

const inches = z.number().positive().max(1000).nullable();

const machineSchema = z.object({
  id: z.string().uuid(),
  x: inches,
  y: inches,
  z: inches,
  diameter: inches,
  length: inches,
  toleranceIn: z.number().min(0.000_01).max(0.1).nullable(),
});

/** A machine's work envelope and the tightest tolerance it holds. */
export const saveMachineLimits = async (
  input: z.infer<typeof machineSchema>
): Promise<Result> => {
  const access = await authorize("shop:write");
  if (!access.ok) {
    return access;
  }
  const parsed = machineSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Sizes must be positive numbers in inches." };
  }
  const { id, toleranceIn, ...size } = parsed.data;
  const box = size.x || size.y || size.z;
  const round_ = size.diameter || size.length;
  if (box && round_) {
    return {
      ok: false,
      error: "Give either X/Y/Z travel or a diameter and length, not both.",
    };
  }
  let envelope: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
  if (box) {
    envelope = { x: size.x, y: size.y, z: size.z };
  } else if (round_) {
    envelope = { diameter: size.diameter, length: size.length };
  }
  const { count } = await forOrg(database, access.orgId).workCenter.updateMany({
    where: { id },
    data: { envelope, toleranceIn },
  });
  if (count === 0) {
    return { ok: false, error: "That machine no longer exists." };
  }
  revalidatePath("/shop/work-centers");
  return { ok: true };
};

const floorSchema = z.object({
  id: z.string().uuid(),
  /** Percent, e.g. 25 for 25%. Null clears it. */
  floorPct: z.number().min(0).max(80).nullable(),
});

/** The lowest margin the owner accepts for a customer. */
export const saveMarginFloor = async (
  input: z.infer<typeof floorSchema>
): Promise<Result> => {
  // A commercial decision: owner and admin.
  const access = await authorize("billing:manage");
  if (!access.ok) {
    return {
      ok: false,
      error: "Only the shop's owner or an admin can set a margin floor.",
    };
  }
  const parsed = floorSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "The floor is a percent from 0 to 80." };
  }
  const { count } = await forOrg(database, access.orgId).customer.updateMany({
    where: { id: parsed.data.id },
    data: {
      marginFloor:
        parsed.data.floorPct === null
          ? null
          : Math.round(parsed.data.floorPct * 100) / 10_000,
    },
  });
  if (count === 0) {
    return { ok: false, error: "That customer no longer exists." };
  }
  revalidatePath("/shop/customers");
  return { ok: true };
};
