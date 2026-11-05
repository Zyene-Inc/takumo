"use server";

import { applyUnsubscribe, checkUnsubscribe } from "@/lib/brief/unsubscribe";

export interface UnsubState {
  message: string;
  status: "idle" | "done" | "error";
}

export const confirmUnsubscribe = async (
  _prev: UnsubState,
  form: FormData
): Promise<UnsubState> => {
  const checked = checkUnsubscribe(String(form.get("t") ?? ""), new Date());
  if (!checked.ok) {
    return { status: "error", message: checked.error };
  }
  await applyUnsubscribe(checked.payload);
  return {
    status: "done",
    message:
      "Done. Turn it back on any time in Takumo under Settings → Notifications.",
  };
};
