import type { ScheduleRequest } from "@repo/engine-client/types";

export interface WorkCenterRow {
  calendar: { availableHours: number; date: Date; reason: string | null }[];
  efficiency: number;
  hourlyRate: { toString(): string } | null;
  id: string;
  name: string;
  operatorsPerMachine?: number;
  shifts: unknown;
  unattendedRuns?: boolean;
}

export interface OperatorRow {
  active: boolean;
  canRunUnattended: boolean;
  days: { date: Date; hours: number; reason: string | null }[];
  id: string;
  name: string;
  shifts: unknown;
  workCenterIds: string[];
}

/** When an order's material is ready (lib/schedule/material.ts). */
export interface ReleaseRow {
  /** YYYY-MM-DD, later than the plan start; null: ready now or unknown. */
  date: string | null;
  note: string;
}

export interface PartRow {
  id: string;
  material: { unit: string; unitCost: { toString(): string } | null } | null;
  partNo: string;
  rev: string;
  routings: {
    altWorkCenterIds: string[];
    runMinPerUnit: number;
    seq: number;
    setupMin: number;
    workCenterId: string;
  }[];
}

export interface OrderRow {
  /** Operations already finished on the floor; only the rest are planned. */
  doneSeqs?: number[];
  dueDate: Date;
  orderNo: string;
  partId: string;
  price: { toString(): string } | null;
  priority: number;
  /** Parts already through an unfinished operation (seq → count), from the
   * ERP's open-operations report: its setup is done and only the rest run. */
  progress?: Record<number, number>;
  qty: number;
}

export interface PinRow {
  orderNo: string;
  plannedStart: Date;
  routingSeq: number;
  workCenterId: string;
}

export interface ShopRows {
  operators?: OperatorRow[];
  orders: OrderRow[];
  parts: PartRow[];
  pins: PinRow[];
  /** Material-ready dates and notes, by order number. */
  release?: Map<string, ReleaseRow>;
  workCenters: WorkCenterRow[];
}

export interface SkippedOrder {
  orderNo: string;
  reason: string;
}

export interface BuiltRequest {
  /** Things Takumo had to assume; shown on the board so someone can fix them. */
  assumptions: string[];
  /** Engine part key for each part id (part numbers, with rev when needed). */
  partKeys: Record<string, string>;
  request: ScheduleRequest;
  skipped: SkippedOrder[];
}

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isoDay = (value: Date) => value.toISOString().slice(0, 10);

export interface BuildOptions {
  /** Parts to include even with no open order (the part being asked about). */
  includeParts?: string[];
  /** Material cost per finished part, by part id, overriding the material's. */
  materialCost?: Record<string, number>;
}
