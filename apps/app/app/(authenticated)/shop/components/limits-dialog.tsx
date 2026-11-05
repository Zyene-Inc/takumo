"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";

interface LimitField {
  hint?: string;
  key: string;
  label: string;
}

/**
 * A small form of optional numbers (machine envelope, a customer's margin
 * floor). Empty means "not set".
 */
export const LimitsDialog = ({
  title,
  description,
  fields,
  initial,
  trigger,
  onSave,
}: {
  description: string;
  fields: LimitField[];
  initial: Record<string, string>;
  onSave: (
    values: Record<string, number | null>
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  title: string;
  trigger: ReactNode;
}) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    const parsed: Record<string, number | null> = {};
    for (const f of fields) {
      const raw = (values[f.key] ?? "").trim().replace(/[%"$,]/g, "");
      if (!raw) {
        parsed[f.key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        setError(`${f.label}: enter a number.`);
        return;
      }
      parsed[f.key] = n;
    }
    start(async () => {
      const r = await onSave(parsed);
      if (r.ok) {
        setError(null);
        setOpen(false);
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <div className="grid gap-1.5" key={f.key}>
              <Label htmlFor={`limit-${f.key}`}>{f.label}</Label>
              <Input
                disabled={pending}
                id={`limit-${f.key}`}
                inputMode="decimal"
                onChange={(e) =>
                  setValues({ ...values, [f.key]: e.target.value })
                }
                value={values[f.key] ?? ""}
              />
              {f.hint && (
                <p className="text-muted-foreground text-xs">{f.hint}</p>
              )}
            </div>
          ))}
        </div>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button disabled={pending} onClick={submit} type="button">
            {pending && <Spinner />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
