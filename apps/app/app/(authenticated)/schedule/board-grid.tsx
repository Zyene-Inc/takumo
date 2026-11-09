"use client";

import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import type {
  OrderResult,
  ScheduledOperation,
  ScheduleRequest,
} from "@repo/engine-client/types";
import type { PointerEvent as ReactPointerEvent } from "react";
import { OperationBar, type OrderInfo } from "./board-parts";
import {
  barGeometry,
  closedReason,
  daysBetween,
  fmtDay,
  orderColour,
} from "./gantt";

export const ROW_HEIGHT = 48;
export const NAME_WIDTH = 168;

export const opKey = (op: Pick<ScheduledOperation, "order_no" | "seq">) =>
  `${op.order_no}#${op.seq}`;

export interface Drag {
  dx: number;
  dy: number;
  key: string;
  row: number;
  x: number;
  y: number;
}

export interface DropTarget {
  day: string;
  machine: string;
  op: ScheduledOperation;
  row: number;
  why: string | null;
}

export const BoardGrid = ({
  pending,
  width,
  days,
  request,
  dayWidth,
  dropTarget,
  operations,
  crews,
  canEdit,
  drag,
  moved,
  orderInfo,
  results,
  dueLine,
  selected,
  updateDrag,
  setSelected,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  canEdit: boolean;
  crews: Readonly<Record<string, string>>;
  dayWidth: number;
  days: readonly string[];
  drag: Drag | null;
  dropTarget: DropTarget | null;
  dueLine: number | null | undefined;
  moved: boolean;
  onPointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    op: ScheduledOperation
  ) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  operations: readonly ScheduledOperation[];
  orderInfo: Readonly<Record<string, OrderInfo>>;
  pending: boolean;
  request: ScheduleRequest;
  results: ReadonlyMap<string, OrderResult>;
  selected: string | null;
  setSelected: (orderNo: string | null) => void;
  updateDrag: (next: Drag | null) => void;
  width: number;
}) => (
  <>
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
                      colour={orderColour(op.order_no)}
                      crew={crews[key]}
                      dimmed={Boolean(selected && selected !== op.order_no)}
                      dragOffset={
                        drag?.key === key && moved
                          ? { x: drag.dx, y: drag.dy }
                          : null
                      }
                      geometry={barGeometry(op, request.start_date, dayWidth)}
                      info={orderInfo[op.order_no]}
                      key={key}
                      onCancel={() => updateDrag(null)}
                      onClick={() => {
                        if (!moved) {
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
  </>
);
