"use client";

import { Button } from "@repo/design-system/components/ui/button";
import Link from "next/link";
import { useActionState } from "react";
import { type ActState, confirmAction } from "./actions";

interface QtyOption {
  label: string;
  qty: number;
}

/** One more tap: confirm (and for "won", which quantity). */
export const ConfirmForm = ({
  token,
  label,
  qtys,
}: {
  label: string;
  qtys: QtyOption[] | null;
  token: string;
}) => {
  const [state, action, pending] = useActionState<ActState, FormData>(
    confirmAction,
    { status: "idle" }
  );
  if (state.status === "done") {
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-lg border p-4">{state.message}</p>
        <Link className="text-sm underline" href="/">
          Open Takumo
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      <input name="t" type="hidden" value={token} />
      {qtys && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm">
            Which quantity did they order?
          </legend>
          {qtys.map((q, i) => (
            <label
              className="flex items-center gap-3 rounded-lg border p-3"
              key={q.qty}
            >
              <input
                defaultChecked={i === 0}
                name="qty"
                required
                type="radio"
                value={q.qty}
              />
              {q.label}
            </label>
          ))}
        </fieldset>
      )}
      {state.status === "error" && (
        <p className="text-destructive text-sm">{state.message}</p>
      )}
      <Button className="h-12 text-base" disabled={pending} type="submit">
        {pending ? "Working…" : label}
      </Button>
    </form>
  );
};
