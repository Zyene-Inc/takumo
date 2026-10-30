"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addCalendarDays, removeCalendarDays } from "./actions";

export const CalendarForm = ({
  machines,
}: {
  machines: { id: string; name: string }[];
}) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [values, setValues] = useState({
    workCenterId: "all",
    from: "",
    to: "",
    hours: "0",
    reason: "",
  });
  const set = (key: keyof typeof values, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  return (
    <form
      className="grid gap-4 rounded-xl border p-4 md:grid-cols-[repeat(5,minmax(0,1fr))_auto] md:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const result = await addCalendarDays({
            ...values,
            to: values.to || values.from,
          });
          if (result.ok) {
            setMessage({
              error: false,
              text: `Saved ${result.count} machine-day${result.count === 1 ? "" : "s"}. Re-plan the board to use them.`,
            });
            setValues((v) => ({ ...v, from: "", to: "", reason: "" }));
            router.refresh();
          } else {
            setMessage({ error: true, text: result.error });
          }
        });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="cal-machine">Machine</Label>
        <Select
          onValueChange={(v) => set("workCenterId", v)}
          value={values.workCenterId}
        >
          <SelectTrigger id="cal-machine">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All machines</SelectItem>
            {machines.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="cal-from">From</Label>
        <Input
          id="cal-from"
          onChange={(e) => set("from", e.target.value)}
          required
          type="date"
          value={values.from}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="cal-to">To (optional)</Label>
        <Input
          id="cal-to"
          min={values.from}
          onChange={(e) => set("to", e.target.value)}
          type="date"
          value={values.to}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="cal-hours">Hours available</Label>
        <Input
          id="cal-hours"
          max={24}
          min={0}
          onChange={(e) => set("hours", e.target.value)}
          required
          step="0.5"
          type="number"
          value={values.hours}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="cal-reason">Reason</Label>
        <Input
          id="cal-reason"
          onChange={(e) => set("reason", e.target.value)}
          placeholder="Holiday, maintenance, Saturday shift…"
          value={values.reason}
        />
      </div>
      <Button disabled={pending} type="submit">
        {pending && <Spinner />} Save
      </Button>
      <p className="text-muted-foreground text-xs md:col-span-6">
        0 hours closes the machine that day. More hours than usual (for example
        a Saturday shift) adds capacity.
      </p>
      {message && (
        <p
          className={
            message.error
              ? "text-destructive text-sm md:col-span-6"
              : "text-sm md:col-span-6"
          }
        >
          {message.text}
        </p>
      )}
    </form>
  );
};

export const RemoveDays = ({
  ids,
  label,
}: {
  ids: string[];
  label: string;
}) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      aria-label={label}
      disabled={pending}
      onClick={() =>
        start(async () => {
          await removeCalendarDays(ids);
          router.refresh();
        })
      }
      size="icon"
      variant="ghost"
    >
      {pending ? <Spinner /> : <Trash2Icon />}
    </Button>
  );
};
