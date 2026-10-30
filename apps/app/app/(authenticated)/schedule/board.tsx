"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
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
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import type {
  OrderResult,
  ScheduledOperation,
  ScheduleRequest,
} from "@repo/engine-client/types";
import { PinIcon, PinOffIcon, RefreshCwIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  type BoardActionResult,
  clearPins,
  moveOperation,
  replanShop,
  unpinOperation,
} from "./actions";
import {
  addDays,
  allowedMachines,
  barGeometry,
  boardDays,
  closedReason,
  daysBetween,
  fmtDay,
  fmtHours,
  fmtTime,
  localToday,
  moveProblem,
  orderHue,
  orderRisk,
} from "./gantt";

export interface OrderInfo {
  customer: string | null;
  id: string;
  partNo: string;
  qty: number;
}

interface BoardProps {
  readonly canEdit: boolean;
  readonly operations: readonly ScheduledOperation[];
  readonly orderInfo: Readonly<Record<string, OrderInfo>>;
  readonly orders: readonly OrderResult[];
  readonly request: ScheduleRequest;
}

const ROW_HEIGHT = 48;
const NAME_WIDTH = 168;
const ZOOMS = [
  { label: "Month", width: 40 },
  { label: "2 weeks", width: 80 },
  { label: "Week", width: 150 },
] as const;

const opKey = (op: Pick<ScheduledOperation, "order_no" | "seq">) =>
  `${op.order_no}#${op.seq}`;

interface Drag {
  dx: number;
  dy: number;
  key: string;
  row: number;
  x: number;
  y: number;
}

export const Board = ({
  request,
  operations,
  orders,
  orderInfo,
  canEdit,
}: BoardProps) => {
  const router = useRouter();
  const [dayWidth, setDayWidth] = useState<number>(ZOOMS[1].width);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [problem, setProblem] = useState<{
    message: string;
    conflicts?: string[];
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const moved = useRef(false);
  // Plans start on the day they're made; the browser knows the local date.
  const [fromEarlierDay, setFromEarlierDay] = useState(false);
  useEffect(() => {
    setFromEarlierDay(localToday() > request.start_date);
  }, [request.start_date]);

  const machines = request.work_centers.map((wc) => wc.name);
  const days = useMemo(
    () => boardDays(request.start_date, operations),
    [request.start_date, operations]
  );
  const results = useMemo(
    () => new Map(orders.map((o) => [o.order_no, o])),
    [orders]
  );
  const byKey = useMemo(
    () => new Map(operations.map((op) => [opKey(op), op])),
    [operations]
  );

  const late = orders.filter((o) => o.days_late > 0);
  const pins = operations.filter((op) => op.pinned);
  const selectedResult = selected ? results.get(selected) : undefined;

  const run = (action: () => Promise<BoardActionResult>) => {
    setProblem(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        router.refresh();
      } else {
        setProblem({ message: result.error, conflicts: result.conflicts });
      }
    });
  };

  const target = (d: Drag) => {
    const op = byKey.get(d.key);
    if (!op) {
      return null;
    }
    const row = Math.min(
      machines.length - 1,
      Math.max(0, d.row + Math.round(d.dy / ROW_HEIGHT))
    );
    const day = addDays(op.start_date, Math.round(d.dx / dayWidth));
    const machine = machines[row];
    return {
      op,
      row,
      day,
      machine,
      why: moveProblem(request, op, machine, day),
    };
  };

  // The live drag lives in a ref: pointer events can arrive faster than React
  // re-renders, and handlers must see the latest position.
  const dragRef = useRef<Drag | null>(null);
  const updateDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const onPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    op: ScheduledOperation
  ) => {
    moved.current = false;
    if (!canEdit || pending || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    updateDrag({
      key: opKey(op),
      x: event.clientX,
      y: event.clientY,
      dx: 0,
      dy: 0,
      row: machines.indexOf(op.work_center),
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current) {
      return;
    }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      moved.current = true;
    }
    updateDrag({ ...current, dx, dy });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current) {
      return;
    }
    // The final position, in case no move event preceded the release.
    const last = {
      ...current,
      dx: event.clientX - current.x,
      dy: event.clientY - current.y,
    };
    if (Math.abs(last.dx) > 4 || Math.abs(last.dy) > 4) {
      moved.current = true;
    }
    const t = moved.current ? target(last) : null;
    updateDrag(null);
    if (!t || (t.day === t.op.start_date && t.machine === t.op.work_center)) {
      return;
    }
    if (t.why) {
      setProblem({ message: t.why });
      return;
    }
    setSelected(t.op.order_no);
    run(() =>
      moveOperation({
        orderNo: t.op.order_no,
        seq: t.op.seq,
        workCenter: t.machine,
        startDate: t.day,
        today: localToday(),
      })
    );
  };

  const dropTarget = drag && moved.current ? target(drag) : null;
  const width = days.length * dayWidth;
  const dueLine =
    selectedResult &&
    (daysBetween(request.start_date, selectedResult.due_date) + 1) * dayWidth;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={late.length ? "destructive" : "secondary"}>
          {orders.length - late.length} of {orders.length} orders on time
        </Badge>
        {pins.length > 0 && (
          <Badge variant="outline">
            <PinIcon /> {pins.length} pinned
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {ZOOMS.map((zoom) => (
            <Button
              key={zoom.label}
              onClick={() => setDayWidth(zoom.width)}
              size="sm"
              variant={dayWidth === zoom.width ? "secondary" : "ghost"}
            >
              {zoom.label}
            </Button>
          ))}
        </div>
        {canEdit && pins.length > 0 && (
          <Button
            disabled={pending}
            onClick={() => run(() => clearPins(localToday()))}
            size="sm"
            variant="outline"
          >
            <PinOffIcon /> Unpin all
          </Button>
        )}
        {canEdit && (
          <Button
            disabled={pending}
            onClick={() => run(() => replanShop(localToday()))}
            size="sm"
          >
            {pending ? <Spinner /> : <RefreshCwIcon />} Re-plan
          </Button>
        )}
      </div>

      {fromEarlierDay && (
        <Alert>
          <AlertTitle>
            This plan starts on {fmtDay(request.start_date)}
          </AlertTitle>
          <AlertDescription>
            {canEdit
              ? "Re-plan to start from today and account for work since then."
              : "Ask a planner to re-plan from today."}
          </AlertDescription>
        </Alert>
      )}

      {problem && (
        <Alert variant="destructive">
          <AlertTitle className="flex items-center justify-between gap-2">
            {problem.message}
            <Button
              aria-label="Dismiss"
              className="size-6"
              onClick={() => setProblem(null)}
              size="icon"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </AlertTitle>
          {problem.conflicts && problem.conflicts.length > 0 && (
            <AlertDescription>
              <ul className="list-disc pl-4">
                {problem.conflicts.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </AlertDescription>
          )}
        </Alert>
      )}

      <div className="relative overflow-x-auto rounded-xl border">
        {pending && (
          <div className="absolute inset-0 z-30 flex items-center justify-center gap-2 bg-background/60 text-sm backdrop-blur-[1px]">
            <Spinner /> Re-planning the shop…
          </div>
        )}
        <div
          className="relative select-none"
          style={{ width: NAME_WIDTH + width }}
        >
          {/* Day header */}
          <div className="sticky top-0 z-20 flex border-b bg-background">
            <div
              className="sticky left-0 z-20 shrink-0 border-r bg-background px-3 py-2 font-medium text-muted-foreground text-xs"
              style={{ width: NAME_WIDTH }}
            >
              Machine
            </div>
            {days.map((day) => (
              <div
                className={cn(
                  "shrink-0 border-r px-1 py-2 text-center text-xs",
                  day === request.start_date
                    ? "font-semibold text-primary"
                    : "text-muted-foreground"
                )}
                key={day}
                style={{ width: dayWidth }}
                title={fmtDay(day, "long")}
              >
                {dayWidth >= 80
                  ? fmtDay(day)
                  : new Date(`${day}T00:00:00Z`).getUTCDate()}
              </div>
            ))}
          </div>

          {/* Machine rows */}
          {request.work_centers.map((wc, row) => (
            <div
              className="relative flex border-b last:border-b-0"
              key={wc.name}
              style={{ height: ROW_HEIGHT }}
            >
              <div
                className="sticky left-0 z-10 flex shrink-0 flex-col justify-center border-r bg-background px-3"
                style={{ width: NAME_WIDTH }}
              >
                <span className="truncate font-medium text-sm">{wc.name}</span>
                <span className="text-muted-foreground text-xs">
                  {wc.hours_per_day} h/day
                </span>
              </div>
              <div className="relative" style={{ width }}>
                {days.map((day, i) => {
                  const closed = closedReason(wc, day);
                  return closed ? (
                    <div
                      className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,transparent,transparent_4px,var(--muted)_4px,var(--muted)_8px)]"
                      key={day}
                      style={{ left: i * dayWidth, width: dayWidth }}
                      title={`${wc.name}: ${closed}`}
                    />
                  ) : null;
                })}
                {days.map((day, i) => (
                  <div
                    className="absolute inset-y-0 border-r border-dashed opacity-60"
                    key={`${day}-line`}
                    style={{ left: (i + 1) * dayWidth - 1 }}
                  />
                ))}
                {dropTarget && dropTarget.row === row && (
                  <div
                    className={cn(
                      "absolute inset-y-1 z-10 rounded-md border-2 border-dashed",
                      dropTarget.why
                        ? "border-destructive bg-destructive/10"
                        : "border-primary bg-primary/10"
                    )}
                    style={{
                      left:
                        daysBetween(request.start_date, dropTarget.day) *
                        dayWidth,
                      width: dayWidth,
                    }}
                  />
                )}
                {operations
                  .filter((op) => op.work_center === wc.name)
                  .map((op) => {
                    const key = opKey(op);
                    return (
                      <OperationBar
                        canEdit={canEdit}
                        dimmed={Boolean(selected && selected !== op.order_no)}
                        dragOffset={
                          drag?.key === key && moved.current
                            ? { x: drag.dx, y: drag.dy }
                            : null
                        }
                        geometry={barGeometry(op, request.start_date, dayWidth)}
                        hue={orderHue(op.order_no)}
                        info={orderInfo[op.order_no]}
                        key={key}
                        onCancel={() => updateDrag(null)}
                        onClick={() => {
                          if (!moved.current) {
                            setSelected(
                              selected === op.order_no ? null : op.order_no
                            );
                          }
                        }}
                        onPointerDown={(e) => onPointerDown(e, op)}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        op={op}
                        result={results.get(op.order_no)}
                      />
                    );
                  })}
              </div>
            </div>
          ))}

          {dueLine !== undefined && dueLine !== null && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10 border-destructive border-l-2 border-dashed"
              style={{ left: NAME_WIDTH + dueLine }}
              title="Due"
            >
              <span className="ml-1 rounded bg-destructive px-1 text-[10px] text-white">
                Due
              </span>
            </div>
          )}
        </div>
      </div>

      {dropTarget && (
        <p className="text-muted-foreground text-sm">
          {dropTarget.why ??
            `Pin ${dropTarget.op.order_no} op ${dropTarget.op.seq} to start ${fmtDay(dropTarget.day)} on ${dropTarget.machine}`}
        </p>
      )}

      <Legend canEdit={canEdit} />

      {selected && selectedResult && (
        <OrderPanel
          canEdit={canEdit}
          info={orderInfo[selected]}
          onClose={() => setSelected(null)}
          onMove={(op, machine, day) => {
            const why = moveProblem(request, op, machine, day);
            if (why) {
              setProblem({ message: why });
              return;
            }
            run(() =>
              moveOperation({
                orderNo: op.order_no,
                seq: op.seq,
                workCenter: machine,
                startDate: day,
                today: localToday(),
              })
            );
          }}
          onUnpin={(op) =>
            run(() =>
              unpinOperation({
                orderNo: op.order_no,
                seq: op.seq,
                today: localToday(),
              })
            )
          }
          operations={operations
            .filter((op) => op.order_no === selected)
            .sort((a, b) => a.seq - b.seq)}
          pending={pending}
          request={request}
          result={selectedResult}
        />
      )}

      <LateOrders late={late} onSelect={setSelected} orderInfo={orderInfo} />
    </div>
  );
};

const barTitle = (
  op: ScheduledOperation,
  info: OrderInfo | undefined,
  result: OrderResult | undefined
) => {
  const lines = [
    `${op.order_no} · op ${op.seq}${op.pinned ? " · pinned" : ""}`,
    `${fmtTime(op.start_at)} → ${fmtTime(op.end_at)} (${fmtHours(op.minutes)})`,
  ];
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

const OperationBar = ({
  op,
  info,
  result,
  geometry,
  hue,
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
  dimmed: boolean;
  dragOffset: { x: number; y: number } | null;
  geometry: { left: number; width: number };
  hue: number;
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
        "absolute inset-y-2 z-10 flex items-center gap-1 overflow-hidden rounded-md px-1.5 text-left text-white text-xs shadow-sm outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring dark:text-black",
        "bg-[hsl(var(--hue)_55%_38%)] dark:bg-[hsl(var(--hue)_50%_62%)]",
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
          "--hue": hue,
          left: geometry.left,
          width: geometry.width,
          transform: dragOffset
            ? `translate(${dragOffset.x}px, ${dragOffset.y}px)`
            : undefined,
        } as React.CSSProperties
      }
      title={barTitle(op, info, result)}
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

const RiskBadge = ({ result }: { result: OrderResult }) => {
  const risk = orderRisk(result.completion_date, result.due_date);
  if (risk === "late") {
    return <Badge variant="destructive">{result.days_late} days late</Badge>;
  }
  if (risk === "tight") {
    return <Badge variant="outline">Tight</Badge>;
  }
  return <Badge variant="secondary">On time</Badge>;
};

const Legend = ({ canEdit }: { canEdit: boolean }) => (
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

const OrderPanel = ({
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

const OperationRow = ({
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

const LateOrders = ({
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
