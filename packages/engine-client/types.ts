// Mirrors services/engine/app/models.py. Keep the two in sync.
// Durations are minutes; dates are ISO strings (YYYY-MM-DD); clock times are
// local shop time without a zone (YYYY-MM-DDTHH:MM:SS).

export interface DayException {
  date: string;
  hours: number;
  reason?: string | null;
}

export interface WorkCenter {
  efficiency?: number;
  exceptions?: DayException[];
  hourly_rate?: number | null;
  hours_per_day: number;
  name: string;
  /** Weekdays it runs, Monday = 0. Defaults to Monday–Friday. */
  working_days?: number[];
}

export interface Operation {
  alt_work_centers?: string[];
  run_min_per_unit: number;
  seq: number;
  setup_min: number;
  work_center: string;
}

export interface Part {
  /** Material cost per finished part. */
  material_cost?: number | null;
  part_no: string;
  routing: Operation[];
}

export interface Order {
  due_date: string;
  order_no: string;
  part_no: string;
  price?: number | null;
  priority?: number;
  qty: number;
}

export interface Pin {
  order_no: string;
  seq: number;
  start_date: string;
  work_center: string;
}

export interface ScheduleRequest {
  capacity_factor?: number;
  day_start?: string;
  orders: Order[];
  parts: Part[];
  pins?: Pin[];
  start_date: string;
  time_limit_s?: number;
  work_centers: WorkCenter[];
}

export interface ScheduledOperation {
  end_at: string;
  end_date: string;
  minutes: number;
  order_no: string;
  pinned: boolean;
  seq: number;
  start_at: string;
  start_date: string;
  work_center: string;
}

export interface OrderResult {
  completion_date: string;
  days_late: number;
  due_date: string;
  order_no: string;
}

export interface DayLoad {
  capacity_minutes: number;
  date: string;
  load_minutes: number;
  work_center: string;
}

export interface Conflict {
  message: string;
  order_no: string;
  seq?: number | null;
}

export type SolverStatus =
  | "OPTIMAL"
  | "FEASIBLE"
  | "HEURISTIC"
  | "INFEASIBLE"
  | "UNKNOWN"
  | "MODEL_INVALID";

export interface ScheduleResponse {
  conflicts: Conflict[];
  load: DayLoad[];
  operations: ScheduledOperation[];
  orders: OrderResult[];
  status: SolverStatus;
  total_days_late: number;
}

export interface CapacityRequest extends ScheduleRequest {
  new_order: Order;
}

export interface SlippedOrder {
  days_late_after: number;
  days_late_before: number;
  order_no: string;
}

export interface Lever {
  completion_date: string | null;
  description: string;
  extra_cost: number | null;
  kind: "overtime" | "alternate_machine" | "split_lot";
  on_time: boolean;
}

export interface CostBreakdown {
  machine: number | null;
  margin: number | null;
  margin_pct: number | null;
  material: number | null;
  missing: string[];
  price: number | null;
  total: number | null;
}

export interface CapacityResponse {
  can_take: boolean;
  cost: CostBreakdown | null;
  explanation: string;
  levers: Lever[];
  /** Earliest finish without moving any existing order. */
  new_order: OrderResult | null;
  /** If the new order went first instead. */
  rush: OrderResult | null;
  slipped: SlippedOrder[];
  status: SolverStatus;
}

/** Plans the engine could build (HEURISTIC = valid but not optimised). */
export const SOLVED_STATUSES: readonly SolverStatus[] = [
  "OPTIMAL",
  "FEASIBLE",
  "HEURISTIC",
];
