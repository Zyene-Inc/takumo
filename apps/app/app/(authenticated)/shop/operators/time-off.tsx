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
import { CalendarOffIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addTimeOff, removeTimeOff } from "./actions";

const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
};

/** Vacation, sick or a short day for one operator. */
export const TimeOffDialog = ({
  operatorId,
  name,
}: {
  name: string;
  operatorId: string;
}) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({
    from: today(),
    to: today(),
    hours: "0",
    reason: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof values, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  const submit = () =>
    start(async () => {
      const result = await addTimeOff({ operatorId, ...values });
      if (result.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error);
      }
    });

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button aria-label={`Time off for ${name}`} size="icon" variant="ghost">
          <CalendarOffIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Time off for {name}</DialogTitle>
          <DialogDescription>
            Vacation, sick days or short days. The plan and every delivery
            answer use the hours they're really in.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="off-from">First day</Label>
            <Input
              id="off-from"
              onChange={(e) => set("from", e.target.value)}
              type="date"
              value={values.from}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="off-to">Last day</Label>
            <Input
              id="off-to"
              onChange={(e) => set("to", e.target.value)}
              type="date"
              value={values.to}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="off-hours">Hours they work those days</Label>
            <Input
              id="off-hours"
              max={24}
              min={0}
              onChange={(e) => set("hours", e.target.value)}
              step="0.5"
              type="number"
              value={values.hours}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="off-reason">Reason</Label>
            <Input
              id="off-reason"
              maxLength={80}
              onChange={(e) => set("reason", e.target.value)}
              placeholder="Vacation"
              value={values.reason}
            />
          </div>
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

/** One upcoming day off, with a remove button. */
export const TimeOffChip = ({
  canEdit,
  id,
  label,
}: {
  canEdit: boolean;
  id: string;
  label: string;
}) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
      {label}
      {canEdit && (
        <button
          aria-label={`Remove ${label}`}
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={pending}
          onClick={() =>
            start(async () => {
              await removeTimeOff(id);
              router.refresh();
            })
          }
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
};
