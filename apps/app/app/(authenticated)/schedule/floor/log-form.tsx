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
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { ClipboardCheckIcon, Undo2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { logOp, undoLog } from "./actions";

export interface LoggableOp {
  machine: string | null;
  orderId: string;
  orderNo: string;
  partNo: string;
  qty: number;
  /** The routing's times, as a hint. */
  runMinPerUnit: number;
  seq: number;
  setupMin: number;
}

const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export const LogButton = ({ op }: { op: LoggableOp }) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({
    setupMin: "",
    runMin: "",
    qtyGood: String(op.qty),
    qtyScrap: "0",
    finishedAt: "",
    note: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof values, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const field = (key: keyof typeof values, label: string, hint?: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${op.orderNo}-${op.seq}-${key}`}>{label}</Label>
      <Input
        id={`${op.orderNo}-${op.seq}-${key}`}
        inputMode="decimal"
        min={0}
        onChange={(e) => set(key, e.target.value)}
        placeholder={hint}
        required
        step="any"
        type="number"
        value={values[key]}
      />
    </div>
  );

  return (
    <Dialog
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setValues((v) => ({ ...v, finishedAt: v.finishedAt || localNow() }));
          setDone(null);
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <ClipboardCheckIcon /> Log
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {op.orderNo} · op {op.seq}
            {op.machine ? ` · ${op.machine}` : ""}
          </DialogTitle>
          <DialogDescription>
            {op.qty.toLocaleString()} × {op.partNo}. What it actually took:
            Takumo compares it with the routing ({op.setupMin} min setup,{" "}
            {op.runMinPerUnit} min/part).
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await logOp({
                orderId: op.orderId,
                seq: op.seq,
                ...values,
              });
              if (r.ok) {
                setError(null);
                setDone(
                  `${r.orderNo} op ${op.seq} logged${r.orderDone ? `; ${r.orderNo} is done` : ""}.${
                    r.facts.length
                      ? ` From your note: ${r.facts.join(", ")} for review.`
                      : ""
                  }`
                );
                router.refresh();
              } else {
                setError(r.error);
              }
            });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            {field("setupMin", "Setup (min)", String(op.setupMin))}
            {field(
              "runMin",
              "Run, whole lot (min)",
              String(Math.round(op.runMinPerUnit * op.qty))
            )}
            {field("qtyGood", "Good parts")}
            {field("qtyScrap", "Scrap")}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${op.orderNo}-${op.seq}-finished`}>Finished</Label>
            <Input
              id={`${op.orderNo}-${op.seq}-finished`}
              onChange={(e) => set("finishedAt", e.target.value)}
              required
              type="datetime-local"
              value={values.finishedAt}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${op.orderNo}-${op.seq}-note`}>
              Anything the next person should know?
            </Label>
            <Textarea
              id={`${op.orderNo}-${op.seq}-note`}
              onChange={(e) => set("note", e.target.value)}
              placeholder="e.g. setup ran long: the vise jaws for this part had to be re-cut"
              rows={2}
              value={values.note}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          {done && <p className="text-emerald-600 text-sm">{done}</p>}
          <DialogFooter>
            {done ? (
              <Button onClick={() => setOpen(false)} type="button">
                Close
              </Button>
            ) : (
              <Button disabled={pending} type="submit">
                {pending && <Spinner />} Log it
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const UndoButton = ({
  jobId,
  label,
}: {
  jobId: string;
  label: string;
}) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      aria-label={`Undo ${label}`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          await undoLog(jobId);
          router.refresh();
        })
      }
      size="icon"
      variant="ghost"
    >
      {pending ? <Spinner /> : <Undo2Icon />}
    </Button>
  );
};

export const PlanLink = () => (
  <Link className="underline" href="/schedule">
    build the plan
  </Link>
);
