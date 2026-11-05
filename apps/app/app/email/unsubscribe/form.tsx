"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useActionState } from "react";
import { confirmUnsubscribe, type UnsubState } from "./actions";

export const UnsubscribeForm = ({ token }: { token: string }) => {
  const [state, action, pending] = useActionState<UnsubState, FormData>(
    confirmUnsubscribe,
    { status: "idle", message: "" }
  );
  if (state.status === "done") {
    return <p className="rounded-lg border p-4">{state.message}</p>;
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <input name="t" type="hidden" value={token} />
      {state.status === "error" && (
        <p className="text-destructive text-sm">{state.message}</p>
      )}
      <Button className="h-12 text-base" disabled={pending} type="submit">
        {pending ? "Working…" : "Stop these emails"}
      </Button>
    </form>
  );
};
