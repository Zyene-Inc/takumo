"use client";

// The schedule board's pieces: operation bars, rows, the order panel, legend and late orders.

import { Badge } from "@repo/design-system/components/ui/badge";
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
import { cn } from "@repo/design-system/lib/utils";
import type {
  OrderResult,
  ScheduledOperation,
  ScheduleRequest,
} from "@repo/engine-client/types";
import { PinIcon, PinOffIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { type PointerEvent as ReactPointerEvent, useState } from "react";
import { allowedMachines, fmtDay, fmtHours, fmtTime, orderRisk } from "./gantt";

export interface OrderInfo {
  customer: string | null;
  id: string;
  partNo: string;
  qty: number;
}

export const barTitle = (
  op: ScheduledOperation,
  info: OrderInfo | undefined,
  result: OrderResult | undefined,
  crew: string | undefined
) => {
  const lines = [
    `${op.order_no} · op ${op.seq}${op.pinned ? " · pinned" : ""}`,
    `${fmtTime(op.start_at)} → ${fmtTime(op.end_at)} (${fmtHours(op.minutes)})`,
  ];
  if (crew) {
    lines.push(`Who: ${crew}`);
  }
  if (info) {
    const customer = info.customer ? ` for ${info.customer}` : "";
    lines.splice(
      1,
      0,
      `${info.qty.toLocaleString()} × ${info.partNo}${customer}`
    );
  }
  if (result) {
    const late = result.days_late ? `, ${result.days_late} days late` : "";
    lines.push(`Due ${fmtDay(result.due_date)}${late}`);
  }
  return lines.join("\n");
};

export const OperationBar = ({
  op,
  info,
  result,
  crew,
  geometry,
  colour,
  canEdit,
  dimmed,
  dragOffset,
  onClick,
  onCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  canEdit: boolean;
  crew: string | undefined;
  dimmed: boolean;
  dragOffset: { x: number; y: number } | null;
  geometry: { left: number; width: number };
  colour: string;
  info: OrderInfo | undefined;
  onCancel: () => void;
  onClick: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  op: ScheduledOperation;
  result: OrderResult | undefined;
}) => {
  const risk = result
    ? orderRisk(result.completion_date, result.due_date)
    : "ok";
  return (
    <button
      aria-label={`${op.order_no} op ${op.seq} on ${op.work_center}, ${fmtTime(op.start_at)} to ${fmtTime(op.end_at)}`}
      className={cn(
        "absolute inset-y-2 z-10 flex items-center gap-1 overflow-hidden rounded-md px-1.5 text-left text-white text-xs shadow-sm outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
        "bg-(--job)",
        risk === "late" &&
          "ring-2 ring-destructive ring-offset-1 ring-offset-background",
        risk === "tight" &&
          "ring-2 ring-amber-500 ring-offset-1 ring-offset-background",
        canEdit && "cursor-grab active:cursor-grabbing",
        dimmed && "opacity-30",
        dragOffset && "z-20 opacity-80 shadow-lg"
      )}
      onClick={onClick}
      onPointerCancel={onCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={
        {
          "--job": colour,
          left: geometry.left,
          width: geometry.width,
          transform: dragOffset
            ? `translate(${dragOffset.x}px, ${dragOffset.y}px)`
            : undefined,
        } as React.CSSProperties
      }
      title={barTitle(op, info, result, crew)}
      type="button"
    >
      {op.pinned && <PinIcon className="size-3 shrink-0" />}
      <span className="truncate">
        {op.order_no}
        {geometry.width > 90 && <span className="opacity-75"> · {op.seq}</span>}
      </span>
    </button>
  );
};

export const RiskBadge = ({ result }: { result: OrderResult }) => {
  const risk = orderRisk(result.completion_date, result.due_date);
  if (risk === "late") {
    return <Badge variant="destructive">{result.days_late} days late</Badge>;
  }
  if (risk === "tight") {
    return <Badge variant="outline">Tight</Badge>;
  }
  return <Badge variant="secondary">On time</Badge>;
};

export const Legend = ({ canEdit }: { canEdit: boolean }) => (
  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs">
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-3 w-5 rounded-sm bg-primary/60 ring-2 ring-destructive" />
      Late order
    </span>
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-3 w-5 rounded-sm bg-primary/60 ring-2 ring-amber-500" />
      Finishes on or a day before its due date
    </span>
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-3 w-5 rounded-sm bg-[repeating-linear-gradient(135deg,transparent,transparent_2px,var(--muted-foreground)_2px,var(--muted-foreground)_3px)] opacity-50" />
      Machine not running
    </span>
    <span className="flex items-center gap-1.5">
      <PinIcon className="size-3" /> Pinned by a planner
    </span>
    {canEdit && (
      <span>
        Drag a bar to another day or an alternate machine to pin it; everything
        else re-plans around it.
      </span>
    )}
  </div>
);

export const OrderPanel = ({
  info,
  result,
  operations,
  request,
  canEdit,
  pending,
  onClose,
  onMove,
  onUnpin,
}: {
  canEdit: boolean;
  info: OrderInfo | undefined;
  onClose: () => void;
  onMove: (op: ScheduledOperation, machine: string, day: string) => void;
  onUnpin: (op: ScheduledOperation) => void;
  operations: ScheduledOperation[];
  pending: boolean;
  request: ScheduleRequest;
  result: OrderResult;
}) => {
  return (
    <section
      aria-label={`Order ${result.order_no}`}
      className="rounded-xl border p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">
            {info ? (
              <Link className="hover:underline" href="/shop/orders">
                {result.order_no}
              </Link>
            ) : (
              result.order_no
            )}{" "}
            <RiskBadge result={result} />
          </h2>
          <p className="text-muted-foreground text-sm">
            {info
              ? `${info.qty.toLocaleString()} × ${info.partNo}${info.customer ? ` for ${info.customer}` : ""} · `
              : ""}
            Due {fmtDay(result.due_date)} · finishes{" "}
            {fmtDay(result.completion_date)}
          </p>
        </div>
        <Button
          aria-label="Close"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      <div className="mt-3 grid gap-2">
        {operations.map((op) => (
          <OperationRow
            canEdit={canEdit}
            // Remount when the plan moves it, so the form shows where it is now.
            key={`${op.seq}-${op.work_center}-${op.start_date}`}
            machines={allowedMachines(request, op.order_no, op.seq)}
            onMove={onMove}
            onUnpin={onUnpin}
            op={op}
            pending={pending}
            today={request.start_date}
          />
        ))}
      </div>
    </section>
  );
};

export const OperationRow = ({
  op,
  machines,
  canEdit,
  pending,
  today,
  onMove,
  onUnpin,
}: {
  canEdit: boolean;
  machines: string[];
  onMove: (op: ScheduledOperation, machine: string, day: string) => void;
  onUnpin: (op: ScheduledOperation) => void;
  op: ScheduledOperation;
  pending: boolean;
  today: string;
}) => {
  const [machine, setMachine] = useState(op.work_center);
  const [day, setDay] = useState(op.start_date);
  const id = `${op.order_no}-${op.seq}`;
  const changed = machine !== op.work_center || day !== op.start_date;
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/40 p-3 text-sm">
      <div className="min-w-48 flex-1">
        <p className="font-medium">
          Op {op.seq} · {op.work_center}{" "}
          {op.pinned && (
            <Badge variant="outline">
              <PinIcon /> Pinned
            </Badge>
          )}
        </p>
        <p className="text-muted-foreground">
          {fmtTime(op.start_at)} → {fmtTime(op.end_at)} · {fmtHours(op.minutes)}
        </p>
      </div>
      {canEdit && (
        <>
          <div className="grid gap-1">
            <Label className="text-xs" htmlFor={`${id}-machine`}>
              Machine
            </Label>
            <Select onValueChange={setMachine} value={machine}>
              <SelectTrigger className="h-8 w-40" id={`${id}-machine`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {machines.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs" htmlFor={`${id}-day`}>
              Start day
            </Label>
            <Input
              className="h-8 w-40"
              id={`${id}-day`}
              min={today}
              onChange={(e) => setDay(e.target.value)}
              type="date"
              value={day}
            />
          </div>
          <Button
            disabled={pending || !changed || !day}
            onClick={() => onMove(op, machine, day)}
            size="sm"
          >
            <PinIcon /> Pin here
          </Button>
          {op.pinned && (
            <Button
              disabled={pending}
              onClick={() => onUnpin(op)}
              size="sm"
              variant="outline"
            >
              <PinOffIcon /> Unpin
            </Button>
          )}
        </>
      )}
    </div>
  );
};

export const LateOrders = ({
  late,
  orderInfo,
  onSelect,
}: {
  late: OrderResult[];
  onSelect: (orderNo: string) => void;
  orderInfo: Readonly<Record<string, OrderInfo>>;
}) =>
  late.length === 0 ? null : (
    <section className="rounded-xl border p-4">
      <h2 className="font-semibold">Late orders</h2>
      <p className="text-muted-foreground text-sm">
        The best plan Takumo found still misses these dates. Try{" "}
        <Link className="underline" href="/schedule/check">
          the levers
        </Link>{" "}
        (overtime, alternates, split lots) or talk to the customer.
      </p>
      <ul className="mt-3 grid gap-1 text-sm">
        {[...late]
          .sort((a, b) => b.days_late - a.days_late)
          .map((o) => (
            <li key={o.order_no}>
              <button
                className="hover:underline"
                onClick={() => onSelect(o.order_no)}
                type="button"
              >
                <span className="font-medium">{o.order_no}</span>
                {orderInfo[o.order_no]?.customer
                  ? ` (${orderInfo[o.order_no].customer})`
                  : ""}
                : due {fmtDay(o.due_date)}, finishes {fmtDay(o.completion_date)}{" "}
                <span className="text-destructive">
                  +{o.days_late} day{o.days_late === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
