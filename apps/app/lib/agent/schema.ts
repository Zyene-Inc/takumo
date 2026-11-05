// The views query_data can read (schema "ask", migration
// 20261031120000_ask_takumo). Described here for the agent's prompt; keep in
// sync with the migration.

interface ViewDoc {
  columns: string;
  name: string;
  notes?: string;
}

const ASK_VIEWS: ViewDoc[] = [
  {
    name: "work_centers",
    columns:
      "name, type, hourly_rate (USD/h), efficiency (0–1.5), hours_per_day",
    notes:
      "Machines and cells. Runs Monday–Friday unless the calendar says otherwise.",
  },
  {
    name: "customers",
    columns: "name, payment_term_days",
  },
  {
    name: "materials",
    columns:
      "name, spec, unit_cost (USD per unit), unit (ea, ft, lb…), lead_time_days",
  },
  {
    name: "parts",
    columns: "part_no, rev, description, customer, material",
  },
  {
    name: "routings",
    columns:
      "part_no, rev, seq (op number), work_center, setup_min, run_min_per_unit, alt_work_centers (text[])",
    notes: "Time for an op = setup_min + run_min_per_unit × qty (minutes).",
  },
  {
    name: "orders",
    columns:
      "order_no, part_no, rev, customer, qty, due_date, price (USD, whole order), priority (0–10), status (open | in_progress | done | cancelled), created_on",
    notes: "Open work is status in ('open', 'in_progress').",
  },
  {
    name: "quotes",
    columns:
      "quote_no, customer, part_no, qty, price (USD, whole quote), lead_time_days, est_cost, actual_cost, status (open | won | lost), quoted_on",
    notes:
      "Win rate = won / (won + lost). Margin = (price − cost) / price, using actual_cost when known, else est_cost.",
  },
  {
    name: "jobs",
    columns:
      "order_no, seq, work_center, planned_start, planned_end, actual_start, actual_end, actual_setup_min, actual_run_min (whole lot), qty_good, qty_scrap, pinned, planned_setup_min, planned_run_min_per_unit",
    notes:
      "One row per order operation: the plan of record, and operations finished on the floor (actual_end not null). planned_* are the times the model gave the job; compare with actuals for estimate accuracy.",
  },
  {
    name: "facts",
    columns:
      "fact_no (F-12), subject_type (routing | work_center | part | material | customer | shop), subject, attribute (setupMin, runMinPerUnit, workCenter, hourlyRate, efficiency, hoursPerDay, unitCost, leadTimeDays, paymentTermDays, note), value, previous_value, status (pending | approved | superseded | rejected), source (chat | voice | note | floor | recalibration | manual), evidence, stated_on, reviewed_on, valid_to",
    notes:
      "Tribal knowledge with history. Approved = in force; superseded = replaced by a newer fact; pending = waiting for review.",
  },
  {
    name: "calendar",
    columns: "work_center, date, available_hours (0 = closed), reason",
    notes: "Holidays, downtime and extra shifts.",
  },
];

export const describeViews = () =>
  ASK_VIEWS.map(
    (v) => `- ${v.name}(${v.columns})${v.notes ? `\n  ${v.notes}` : ""}`
  ).join("\n");
