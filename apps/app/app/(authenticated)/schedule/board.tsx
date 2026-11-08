"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
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
import { BoardGrid, type Drag, opKey, ROW_HEIGHT } from "./board-grid";
import { LateOrders, Legend, type OrderInfo, OrderPanel } from "./board-parts";
import {
  addDays,
  boardDays,
  daysBetween,
  fmtDay,
  localToday,
  moveProblem,
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

const ZOOMS = [
  { label: "Month", width: 40 },
  { label: "2 weeks", width: 80 },
  { label: "Week", width: 150 },
] as const;

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

      <BoardGrid
        canEdit={canEdit}
        crews={crews}
        days={days}
        dayWidth={dayWidth}
        drag={drag}
        dropTarget={dropTarget}
        dueLine={dueLine}
        moved={moved.current}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        operations={operations}
        orderInfo={orderInfo}
        pending={pending}
        request={request}
        results={results}
        selected={selected}
        setSelected={setSelected}
        updateDrag={updateDrag}
        width={width}
      />

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
