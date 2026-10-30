// Mirrors services/engine/app/models.py. Keep the two in sync.
// Times are minutes; dates are ISO strings (YYYY-MM-DD).

export interface WorkCenter {
  efficiency?: number;
  hours_per_day: number;
  name: string;
}

export interface Operation {
  alt_work_centers?: string[];
  run_min_per_unit: number;
  seq: number;
  setup_min: number;
  work_center: string;
}

export interface Part {
  part_no: string;
  routing: Operation[];
}

export interface Order {
  due_date: string;
  order_no: string;
  part_no: string;
  priority?: number;
  qty: number;
}

export interface ScheduleRequest {
  capacity_factor?: number;
  orders: Order[];
  parts: Part[];
  start_date: string;
  time_limit_s?: number;
  work_centers: WorkCenter[];
}

export interface ScheduledOperation {
  end_date: string;
  minutes: number;
  order_no: string;
  seq: number;
  start_date: string;
  work_center: string;
}

export interface OrderResult {
  completion_date: string;
  days_late: number;
  due_date: string;
  order_no: string;
}

export interface ScheduleResponse {
  operations: ScheduledOperation[];
  orders: OrderResult[];
  status: "OPTIMAL" | "FEASIBLE" | "INFEASIBLE" | "UNKNOWN" | "MODEL_INVALID";
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
  description: string;
  kind: "overtime" | "alternate_machine";
  on_time: boolean;
}

export interface CapacityResponse {
  can_take: boolean;
  explanation: string;
  levers: Lever[];
  new_order: OrderResult | null;
  slipped: SlippedOrder[];
  status: string;
}
