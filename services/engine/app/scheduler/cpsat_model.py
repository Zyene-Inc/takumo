"""Job-shop scheduler on OR-Tools CP-SAT.

Model (MVP):
- Each work center has its own time axis in *working minutes*
  (minutes_per_day per working day), so shift lengths can differ.
- Each operation runs on its primary work center or one alternate
  (optional intervals + ExactlyOne), with NoOverlap per work center.
- Operations of the same order follow routing sequence at *day*
  granularity: an operation may start the same day its predecessor ends.
- Objective: minimise priority-weighted days late, then total completion
  days, then use of alternate machines.
"""

from dataclasses import dataclass

from ortools.sat.python import cp_model

from app.models import (
    Order,
    OrderResult,
    ScheduledOperation,
    ScheduleRequest,
    ScheduleResponse,
)
from app.scheduler.calendar import date_to_day_index, day_index_to_date

LATENESS_WEIGHT = 1000
ALT_MACHINE_PENALTY = 1


@dataclass
class _Candidate:
    work_center: str
    presence: cp_model.IntVar
    start_day: cp_model.IntVar
    end_day: cp_model.IntVar
    minutes: int


@dataclass
class _Op:
    order_no: str
    seq: int
    start_day: cp_model.IntVar
    end_day: cp_model.IntVar
    candidates: list[_Candidate]


def _horizon_days(request: ScheduleRequest) -> int:
    """Upper bound on schedule length in working days."""
    parts = {p.part_no: p for p in request.parts}
    min_capacity = min(
        wc.minutes_per_day * request.capacity_factor for wc in request.work_centers
    )
    total_minutes = sum(
        op.duration(order.qty)
        for order in request.orders
        for op in parts[order.part_no].routing
    )
    latest_due = max(
        (date_to_day_index(request.start_date, o.due_date) for o in request.orders),
        default=0,
    )
    return max(latest_due, 0) + int(total_minutes / min_capacity) + 10


def _validate(request: ScheduleRequest) -> None:
    work_centers = {wc.name for wc in request.work_centers}
    parts = {p.part_no: p for p in request.parts}
    for order in request.orders:
        if order.part_no not in parts:
            raise ValueError(f"Order {order.order_no}: unknown part {order.part_no}")
        for op in parts[order.part_no].routing:
            if op.work_center not in work_centers:
                raise ValueError(
                    f"Part {order.part_no} op {op.seq}: unknown work center {op.work_center}"
                )


def solve_schedule(request: ScheduleRequest) -> ScheduleResponse:
    _validate(request)
    if not request.orders:
        return ScheduleResponse(status="OPTIMAL")

    model = cp_model.CpModel()
    horizon = _horizon_days(request)
    parts = {p.part_no: p for p in request.parts}
    capacity = {
        wc.name: max(1, round(wc.minutes_per_day * request.capacity_factor))
        for wc in request.work_centers
    }
    intervals: dict[str, list[cp_model.IntervalVar]] = {wc: [] for wc in capacity}
    ops_by_order: dict[str, list[_Op]] = {}
    alt_presences: list[cp_model.IntVar] = []

    for order in request.orders:
        routing = sorted(parts[order.part_no].routing, key=lambda op: op.seq)
        order_ops: list[_Op] = []
        for op in routing:
            minutes = op.duration(order.qty)
            names = [op.work_center] + [
                alt for alt in op.alt_work_centers if alt in capacity and alt != op.work_center
            ]
            op_start = model.new_int_var(0, horizon, f"{order.order_no}_{op.seq}_sd")
            op_end = model.new_int_var(0, horizon, f"{order.order_no}_{op.seq}_ed")
            candidates: list[_Candidate] = []
            for index, wc in enumerate(names):
                cap = capacity[wc]
                tag = f"{order.order_no}_{op.seq}_{wc}"
                presence = model.new_bool_var(f"{tag}_p")
                start = model.new_int_var(0, horizon * cap, f"{tag}_s")
                end = model.new_int_var(minutes, horizon * cap + minutes, f"{tag}_e")
                interval = model.new_optional_interval_var(
                    start, minutes, end, presence, f"{tag}_i"
                )
                intervals[wc].append(interval)

                start_day = model.new_int_var(0, horizon + minutes, f"{tag}_sd")
                end_day = model.new_int_var(0, horizon + minutes, f"{tag}_ed")
                end_minus_one = model.new_int_var(0, horizon * cap + minutes, f"{tag}_em1")
                model.add(end_minus_one == end - 1)
                model.add_division_equality(start_day, start, cap)
                model.add_division_equality(end_day, end_minus_one, cap)

                model.add(op_start == start_day).only_enforce_if(presence)
                model.add(op_end == end_day).only_enforce_if(presence)
                candidates.append(_Candidate(wc, presence, start_day, end_day, minutes))
                if index > 0:
                    alt_presences.append(presence)

            model.add_exactly_one(c.presence for c in candidates)
            order_ops.append(_Op(order.order_no, op.seq, op_start, op_end, candidates))

        for previous, current in zip(order_ops, order_ops[1:]):
            model.add(current.start_day >= previous.end_day)
        ops_by_order[order.order_no] = order_ops

    for wc_intervals in intervals.values():
        if wc_intervals:
            model.add_no_overlap(wc_intervals)

    lateness: dict[str, cp_model.IntVar] = {}
    objective_terms = []
    for order in request.orders:
        last = ops_by_order[order.order_no][-1]
        due = date_to_day_index(request.start_date, order.due_date)
        late = model.new_int_var(0, horizon + 1, f"{order.order_no}_late")
        model.add(late >= last.end_day - due)
        lateness[order.order_no] = late
        objective_terms.append(LATENESS_WEIGHT * (order.priority + 1) * late)
        objective_terms.append(last.end_day)
    objective_terms.extend(ALT_MACHINE_PENALTY * p for p in alt_presences)
    model.minimize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = request.time_limit_s
    solver.parameters.num_workers = 8
    status = solver.solve(model)
    status_name = solver.status_name(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return ScheduleResponse(status=status_name)

    operations: list[ScheduledOperation] = []
    results: list[OrderResult] = []
    for order in request.orders:
        for op in ops_by_order[order.order_no]:
            chosen = next(c for c in op.candidates if solver.value(c.presence))
            operations.append(
                ScheduledOperation(
                    order_no=order.order_no,
                    seq=op.seq,
                    work_center=chosen.work_center,
                    start_date=day_index_to_date(request.start_date, solver.value(op.start_day)),
                    end_date=day_index_to_date(request.start_date, solver.value(op.end_day)),
                    minutes=chosen.minutes,
                )
            )
        last = ops_by_order[order.order_no][-1]
        results.append(
            OrderResult(
                order_no=order.order_no,
                due_date=order.due_date,
                completion_date=day_index_to_date(
                    request.start_date, solver.value(last.end_day)
                ),
                days_late=solver.value(lateness[order.order_no]),
            )
        )

    return ScheduleResponse(
        status=status_name,
        operations=operations,
        orders=results,
        total_days_late=sum(r.days_late for r in results),
    )


def order_result(response: ScheduleResponse, order: Order) -> OrderResult | None:
    return next((r for r in response.orders if r.order_no == order.order_no), None)
