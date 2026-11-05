"use server";

import { performAction } from "@/lib/brief/act";

export type ActState =
  | { status: "idle" }
  | { status: "done"; message: string }
  | { status: "error"; message: string };

/** The confirmation's POST: the only place an email link changes anything. */
export const confirmAction = async (
  _prev: ActState,
  form: FormData
): Promise<ActState> => {
  const token = String(form.get("t") ?? "");
  const qtyRaw = form.get("qty");
  const qty = qtyRaw ? Number(qtyRaw) : null;
  const result = await performAction(
    token,
    qty !== null && Number.isInteger(qty) && qty > 0 ? qty : null,
    new Date()
  );
  return result.ok
    ? { status: "done", message: result.message }
    : { status: "error", message: result.error };
};
