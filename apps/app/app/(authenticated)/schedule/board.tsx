"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import type {
  OrderResult,
  ScheduledOperation,
  ScheduleRequest,
} from "@repo/engine-client/types";
import { PinIcon, PinOffIcon, RefreshCwIcon, XIcon } from "lucide-react";
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
  LateOrders,
  Legend,
  OperationBar,
  type OrderInfo,
  OrderPanel,
} from "./board-parts";
import {
  addDays,
  barGeometry,
  boardDays,
  closedReason,
  daysBetween,
  fmtDay,
  localToday,
  moveProblem,
  orderHue,
} from "./gantt";

export type { OrderInfo } from "./board-parts";

interface BoardProps {
  readonly canEdit: boolean;
  /** Who runs each operation, in words, by `${order_no}#${seq}`. */
  readonly crews?: Readonly<Record<string, string>>;
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
  crews = {},
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
                        crew={crews[key]}
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
