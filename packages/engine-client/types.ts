// Mirrors services/engine/app/models.py. Keep the two in sync.
// Durations are minutes; dates are ISO strings (YYYY-MM-DD); clock times are
// local shop time without a zone (YYYY-MM-DDTHH:MM:SS).

export interface DayException {
  date: string;
  hours: number;
  reason?: string | null;
}

/** Clock hours on given weekdays (Monday = 0); an end at or before the
 * start runs past midnight. */
export interface ShiftWindow {
  days?: number[];
  end: string;
  start: string;
}

export interface WorkCenter {
  efficiency?: number;
  exceptions?: DayException[];
  hourly_rate?: number | null;
  hours_per_day: number;
  name: string;
  /** People needed while it runs: 0.5 = one person runs two machines. */
  operators_per_machine?: number;
  /** Clock windows it runs; empty = hours_per_day from day_start. */
  shifts?: ShiftWindow[];
  /** Runs need nobody once set up (lights-out). */
  unattended_runs?: boolean;
  /** Weekdays it runs, Monday = 0. Defaults to Monday–Friday. */
  working_days?: number[];
}

/** Someone who runs machines (F3.1); their hours limit the machines'. */
export interface Operator {
  id: string;
  name: string;
  /** Empty: any time a machine they run is running. */
  shifts?: ShiftWindow[];
  /** Vacation, sick (hours 0) or short days. */
  time_off?: DayException[];
  /** Can set up a machine and leave it running. */
  unattended?: boolean;
  /** Machines they're qualified to run (work center names). */
  work_centers: string[];
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
  /** No operation starts before this day (e.g. when the material arrives). */
  release_date?: string | null;
  /** Where the material comes from, in words (F3.2-R4). */
  release_note?: string | null;
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
  /** The shop's people; empty = machines' hours aren't limited by staff. */
  operators?: Operator[];
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

/** Who runs an operation, and when (F3.3 v2): one stretch of one person's
 * time on one machine, at real shift clock times. */
export interface OperatorAssignment {
  end_at: string;
  minutes: number;
  operator: string;
  operator_id: string;
  order_no: string;
  seq: number;
  /** Only the setup: the machine then runs with nobody (lights-out). */
  setup_only: boolean;
  start_at: string;
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
  /** The machine's own hours (before staffing); more than capacity_minutes
   * means not enough qualified people on shift that day. */
  machine_minutes?: number | null;
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
  /** Who runs what, when (with operators; plans made before v2 have none). */
  assignments?: OperatorAssignment[];
  conflicts: Conflict[];
  load: DayLoad[];
  /** Notes about the inputs, e.g. machines nobody is listed to run. */
  notices?: string[];
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
  kind:
    | "overtime"
    | "alternate_machine"
    | "split_lot"
    | "extra_operator"
    | "expedite_material";
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

// --- Quoting (services/engine/app/quote) ---------------------------------

/** Where an operation's times come from. */
export type OperationSource =
  | "routing"
  | "actuals"
  | "comparable"
  | "estimator";

export interface QuoteOperation extends Operation {
  note?: string | null;
  source?: OperationSource;
}

export interface QuoteMaterial {
  lead_time_days?: number | null;
  name: string;
  unit?: string;
  unit_cost?: number | null;
  /** Stock used per finished part, in `unit`. Overrides the calibrated cost. */
  usage_per_part?: number | null;
}

export interface OutsideProcess {
  cost_per_lot?: number | null;
  cost_per_unit?: number | null;
  description: string;
}

export interface PastQuote {
  actual_cost?: number | null;
  customer?: string | null;
  est_cost?: number | null;
  lead_time_days?: number | null;
  part_no?: string | null;
  price?: number | null;
  qty: number;
  quote_no: string;
  quoted_at: string;
  status: string;
}

export interface HistoryPart {
  material?: string | null;
  part_no: string;
  routing: Operation[];
}

export interface QuoteSpec {
  customer?: string | null;
  default_margin?: number | null;
  material?: QuoteMaterial | null;
  outside?: OutsideProcess[];
  part_no: string;
  qty_breaks: number[];
  requested_date?: string | null;
  routing: QuoteOperation[];
  target_margin?: number | null;
}

export interface QuoteRequest extends ScheduleRequest {
  history: PastQuote[];
  history_parts: HistoryPart[];
  /** false: price only, no lead times. */
  lead_times?: boolean;
  quote: QuoteSpec;
}

export interface CostLine {
  amount: number | null;
  basis: string;
  kind: "machine" | "material" | "outside";
  label: string;
  /** Citable ids, e.g. "routing P-1001 op 10", "quote Q-9001". */
  sources: string[];
}

export interface QuoteBreak {
  completion_date: string | null;
  cost: number | null;
  lead_time_days: number | null;
  lines: CostLine[];
  margin_pct: number | null;
  meets_requested: boolean | null;
  price: number | null;
  price_high: number | null;
  price_low: number | null;
  qty: number;
  unit_cost: number | null;
  unit_price: number | null;
}

export interface Comparable {
  customer: string | null;
  lead_time_days: number | null;
  margin_basis: "actual" | "estimated" | null;
  margin_pct: number | null;
  part_no: string | null;
  price: number | null;
  qty: number;
  quote_no: string;
  quoted_at: string;
  reasons: string[];
  score: number;
  status: string;
  unit_price: number | null;
}

export interface MarginPolicy {
  basis: string;
  high: number | null;
  low: number | null;
  sources: string[];
  target: number | null;
}

export interface QuoteResponse {
  breaks: QuoteBreak[];
  /** Price sanity checks against past quotes for the same part. */
  checks: string[];
  comparables: Comparable[];
  lead_time_note: string | null;
  margin: MarginPolicy;
  /** What blocks a price. */
  missing: string[];
  /** Schedule status for the lead times, or PRICE_ONLY. */
  status: SolverStatus | "PRICE_ONLY";
  /** Priced, but someone should look. */
  warnings: string[];
}
