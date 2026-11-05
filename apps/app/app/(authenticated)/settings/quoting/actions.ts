"use server";

import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/access";
import { type QuoteSettingsForm, quoteSettingsSchema } from "./schema";

const ONLY_ADMINS =
  "Only the shop's owner or an admin can change how the shop quotes.";

/** Save how the shop quotes (validity, markup, rates, suppliers, signature). */
export const saveQuoteSettings = async (
  input: QuoteSettingsForm
): Promise<{ ok: true } | { ok: false; error: string }> => {
  // Owner and admin, the same people who manage the plan.
  const access = await authorize("billing:manage");
  if (!access.ok) {
    return { ok: false, error: ONLY_ADMINS };
  }
  const parsed = quoteSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `${issue?.path.join(" ") || "Settings"}: ${issue?.message ?? "not valid"}`,
    };
  }
  const v = parsed.data;
  const data = {
    quoteValidityDays: v.quoteValidityDays,
    materialMarkup: Math.round(v.materialMarkupPct * 100) / 10_000,
    laborRate: v.laborRate,
    defaultMargin: Math.round(v.defaultMarginPct * 100) / 10_000,
    toleranceIn: v.toleranceIn,
    certifications: [...new Set(v.certifications)],
    outsideProcesses: v.outsideProcesses as object[],
    signature: v.signature || null,
    replyIntro: v.replyIntro || null,
  };
  await forOrg(database, access.orgId).shopSettings.upsert({
    where: { orgId: access.orgId },
    create: { orgId: access.orgId, ...data },
    update: data,
  });
  revalidatePath("/settings/quoting");
  return { ok: true };
};
