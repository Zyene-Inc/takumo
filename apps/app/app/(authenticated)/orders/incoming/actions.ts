"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/access";
import { track } from "@/lib/analytics";
import { featureProblem } from "@/lib/billing";
import { intakePo, readPo } from "@/lib/orders/intake";
import { readPasted, readRfqUpload } from "@/lib/quotes/read";
import { isUploadId, MAX_UPLOAD_BYTES } from "@/lib/quotes/upload-limits";
import { keepUploadPart, takeUpload } from "@/lib/quotes/upload-parts";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const refresh = (poId?: string) => {
  revalidatePath("/orders/incoming");
  if (poId) {
    revalidatePath(`/orders/incoming/${poId}`);
  }
};

/** One piece of a large PO upload (the host caps each request at 4.5 MB). */
export const uploadPoPart = async (form: FormData): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const blob = form.get("part");
  if (!(blob instanceof Blob)) {
    return { ok: false, error: "That upload isn't valid. Try again." };
  }
  const problem = await keepUploadPart(
    access.orgId,
    {
      uploadId: String(form.get("uploadId") ?? ""),
      fileIndex: Number(form.get("fileIndex")),
      partIndex: Number(form.get("partIndex")),
      name: String(form.get("name") ?? ""),
    },
    new Uint8Array(await blob.arrayBuffer())
  );
  return problem ? { ok: false, error: problem } : { ok: true };
};

const poText = async (orgId: string, form: FormData) => {
  const mode = String(form.get("mode") ?? "paste");
  if (mode !== "upload") {
    const typed = String(form.get("text") ?? "").trim();
    return typed.length >= 10
      ? readPasted(typed)
      : { error: "Paste the PO email or its text." };
  }
  const uploadId = String(form.get("uploadId") ?? "");
  const files = isUploadId(uploadId) ? await takeUpload(orgId, uploadId) : [];
  if (files.length === 0) {
    return { error: "Choose the PO file." };
  }
  if (files.reduce((sum, f) => sum + f.bytes.length, 0) > MAX_UPLOAD_BYTES) {
    return { error: "Upload up to 20 MB at once." };
  }
  const text = await readRfqUpload(files);
  return { ...text, source: "upload" as const };
};

/** A customer PO uploaded or pasted by a person: read and checked now. */
export const submitPo = async (
  form: FormData
): Promise<Result<{ id: string }>> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const locked = await featureProblem(access.orgId, "quotes");
  if (locked) {
    return { ok: false, error: locked };
  }
  const { userId } = await auth();
  try {
    const text = await poText(access.orgId, form);
    if ("error" in text) {
      return { ok: false, error: text.error as string };
    }
    const po = await intakePo(access.orgId, userId ?? null, text);
    track("po_received", {
      orgId: access.orgId,
      userId,
      properties: { source: text.source },
    });
    refresh(po.id);
    return { ok: true, id: po.id };
  } catch (error) {
    log.warn("PO intake failed", { error: String(error) });
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Couldn't read that PO.",
    };
  }
};

const WAITING = ["review", "failed"];

/** Someone entered it in the ERP (or the ERP's report showed it). */
export const markPoEntered = async (poId: string): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const { userId } = await auth();
  const { count } = await forOrg(database, access.orgId).customerPo.updateMany({
    where: { id: poId, status: { in: WAITING } },
    data: { status: "entered", enteredAt: new Date(), enteredBy: userId },
  });
  if (count === 0) {
    return { ok: false, error: "This PO isn't waiting to be entered." };
  }
  track("po_entered", {
    orgId: access.orgId,
    userId,
    properties: { by: "person" },
  });
  refresh(poId);
  return { ok: true };
};

/** Not an order to enter (a duplicate, a mistake, a cancelled PO). */
export const rejectPo = async (poId: string): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const { count } = await forOrg(database, access.orgId).customerPo.updateMany({
    where: { id: poId, status: { in: WAITING } },
    data: { status: "rejected" },
  });
  if (count === 0) {
    return { ok: false, error: "This PO isn't waiting to be entered." };
  }
  refresh(poId);
  return { ok: true };
};

/** Read the PO again (after a failure, or once the quote exists). */
export const rereadPo = async (poId: string): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const db = forOrg(database, access.orgId);
  const { count } = await db.customerPo.updateMany({
    where: { id: poId, status: { in: WAITING } },
    data: { status: "reading", error: null },
  });
  if (count === 0) {
    return { ok: false, error: "This PO can't be read again." };
  }
  await readPo(access.orgId, poId);
  refresh(poId);
  return { ok: true };
};
