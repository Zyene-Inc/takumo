"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/access";
import { track } from "@/lib/analytics";
import { SUBJECT_TYPES } from "@/lib/facts/attributes";
import {
  approveFact,
  proposeFact,
  rejectFact,
  subjectById,
} from "@/lib/facts/facts";
import { publishFact } from "@/lib/facts/visibility";
import { resolveViewer } from "@/lib/library/viewer";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const refresh = () => {
  revalidatePath("/knowledge/facts");
  revalidatePath("/knowledge/calibration");
  revalidatePath("/shop", "layout");
};

// The reviewer as a viewer made on the server: they act only on facts they
// may see (lib/facts/visibility.ts).
const reviewer = async () => {
  const access = await authorize("knowledge:review");
  if (!access.ok) {
    return access;
  }
  const viewer = await resolveViewer();
  return viewer?.userId && viewer.orgId === access.orgId
    ? { ok: true as const, orgId: viewer.orgId, userId: viewer.userId, viewer }
    : { ok: false as const, error: "Sign in again." };
};

/**
 * Approve a fact, with a corrected value if the reviewer changed it.
 * `publish`: the reviewer confirmed publishing a restricted fact to the
 * company, which approving it would do (a change to a record).
 */
export const approve = async (
  factId: string,
  value: string | null,
  note: string | null,
  publish = false
): Promise<Result<{ label: string }>> => {
  const r = await reviewer();
  if (!r.ok) {
    return r;
  }
  const result = await approveFact(r.viewer, factId, {
    ...(value === null ? {} : { value }),
    note,
    publish: publish === true,
  });
  refresh();
  if (result.ok) {
    track("fact_reviewed", {
      orgId: r.orgId,
      userId: r.userId,
      properties: { decision: "approved" },
    });
  }
  return result;
};

export const reject = async (
  factId: string,
  note: string | null
): Promise<Result<{ label: string }>> => {
  const r = await reviewer();
  if (!r.ok) {
    return r;
  }
  const result = await rejectFact(r.viewer, factId, note);
  refresh();
  if (result.ok) {
    track("fact_reviewed", {
      orgId: r.orgId,
      userId: r.userId,
      properties: { decision: "rejected" },
    });
  }
  return result;
};

/** Publish a restricted fact to the whole company (audited). */
export const publish = async (
  factId: string
): Promise<Result<{ label: string }>> => {
  const r = await reviewer();
  if (!r.ok) {
    return r;
  }
  const result = await publishFact(r.viewer, factId);
  refresh();
  return result;
};

const NewFact = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().min(1, "Choose what it's about."),
  attribute: z.string().min(1, "Choose what it says."),
  value: z.string().trim().min(1, "Enter the value."),
  evidence: z.string().trim().max(2000),
});

/** Anyone in the shop can record a fact; it waits for review. */
export const addFact = async (
  values: z.input<typeof NewFact>
): Promise<Result<{ label: string }>> => {
  const viewer = await resolveViewer();
  if (!viewer?.userId) {
    return { ok: false, error: "Choose a shop first." };
  }
  const { orgId, userId } = viewer;
  const parsed = NewFact.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  }
  const v = parsed.data;
  const subject = await subjectById(orgId, v.subjectType, v.subjectId);
  if (!subject) {
    return { ok: false, error: "That record no longer exists." };
  }
  const made = await proposeFact(orgId, {
    subject,
    attribute: v.attribute,
    value: v.value,
    evidence: v.evidence || null,
    source: "manual",
    statedBy: userId,
    // Only a pending fact this person may see can absorb theirs; otherwise a
    // guessed value would reveal a hidden fact's number (security audit M4).
    viewer,
  });
  refresh();
  return made.ok ? { ok: true, label: made.fact.label } : made;
};
