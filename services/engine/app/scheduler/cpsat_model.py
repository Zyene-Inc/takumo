"""Job-shop scheduler on OR-Tools CP-SAT.

Model:
- Each work center has its own axis in available minutes (see calendar.py),
  so shift lengths, weekends, holidays and downtime are all respected and an
  operation simply runs across the gaps.
- Each operation runs on its primary work center or one alternate (optional
  intervals + ExactlyOne), with NoOverlap per work center.
- Operations of an order follow routing sequence in shop time: the next
  operation starts no earlier than the clock time the previous one finishes.
- Pinned operations are fixed to their machine and start day.
- Objective: minimise priority-weighted days late, then completion days,
  then use of alternate machines.

The dispatch plan sizes the horizon and warm-starts the search; if CP-SAT
finds nothing in the time limit, the dispatch plan is returned instead.
"""

import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import timedelta

from ortools.sat.python import cp_model

from app.models import (
    Conflict,
    DayLoad,
    Order,
    OrderResult,
    ScheduledOperation,
    ScheduleRequest,
    ScheduleResponse,
)
from app.scheduler.calendar import DAY, Timeline, day_index, to_datetime
from app.scheduler.dispatch import Placement, candidates, dispatch

LATENESS_WEIGHT = 1000
ALT_MACHINE_PENALTY = 1
# Above this many operations CP-SAT can't improve on dispatch within seconds.
MAX_CP_OPERATIONS = 1500
# Stop searching after this long without finding a better plan.
STALL_S = 2.0


@dataclass
class _Candidate:
    work_center: str
    presence: cp_model.IntVar
    start: cp_model.IntVar
    end: cp_model.IntVar


def _validate(request: ScheduleRequest) -> None:
    work_centers = {wc.name for wc in request.work_centers}
    if len(work_centers) != len(request.work_centers):
        raise ValueError("Work center names must be unique")
    parts = {p.part_no: p for p in request.parts}
    order_nos = [o.order_no for o in request.orders]
    if len(set(order_nos)) != len(order_nos):
        raise ValueError("Order numbers must be unique")
    for order in request.orders:
        if order.part_no not in parts:
            raise ValueError(f"Order {order.order_no}: unknown part {order.part_no}")
        for op in parts[order.part_no].routing:
            if op.work_center not in work_centers:
                raise ValueError(
                    f"Part {order.part_no} op {op.seq}: unknown work center {op.work_center}"
                )
    for pin in request.pins:
        order = next((o for o in request.orders if o.order_no == pin.order_no), None)
        if order is None:
            raise ValueError(f"Pin for unknown order {pin.order_no}")
        op = next((o for o in parts[order.part_no].routing if o.seq == pin.seq), None)
        if op is None:
            raise ValueError(f"Pin for unknown operation {pin.order_no} op {pin.seq}")
        if pin.work_center not in [op.work_center, *op.alt_work_centers]:
            raise ValueError(
                f"{pin.order_no} op {pin.seq} can't run on {pin.work_center} "
                "(not its machine or an alternate)"
            )
        if pin.start_date < request.start_date:
            raise ValueError(f"Pin for {pin.order_no} op {pin.seq} is before the plan start")


def _timelines(request: ScheduleRequest) -> dict[str, Timeline]:
    timelines = {
        wc.name: Timeline(wc, request.start_date, request.capacity_factor)
        for wc in request.work_centers
    }
    for timeline in timelines.values():
        timeline.ensure(60)
        if timeline.cum[-1] == 0 and not timeline.work_center.working_days:
            raise ValueError(f"{timeline.work_center.name} has no working days")
    return timelines


def build_response(
    request: ScheduleRequest,
    status: str,
    placements: dict[tuple[str, int], Placement],
    timelines: dict[str, Timeline],
    conflicts: list[Conflict] | None = None,
) -> ScheduleResponse:
    parts = {p.part_no: p for p in request.parts}
    operations: list[ScheduledOperation] = []
    results: list[OrderResult] = []
    load: dict[tuple[str, int], int] = defaultdict(int)
    last_day = 0

    for order in request.orders:
        end_day = 0
        for op in sorted(parts[order.part_no].routing, key=lambda o: o.seq):
            placed = placements[(order.order_no, op.seq)]
            timeline = timelines[placed.work_center]
            start_abs = timeline.abs_start(placed.start)
            end_abs = timeline.abs_end(placed.end)
            start_day = timeline.day_of(placed.start)
            end_day = timeline.day_of(placed.end - 1)
            operations.append(
                ScheduledOperation(
                    order_no=order.order_no,
                    seq=op.seq,
                    work_center=placed.work_center,
                    start_date=request.start_date + timedelta(days=start_day),
                    end_date=request.start_date + timedelta(days=end_day),
                    start_at=to_datetime(request.start_date, request.day_start, start_abs),
                    end_at=to_datetime(request.start_date, request.day_start, end_abs),
                    minutes=placed.end - placed.start,
                    pinned=placed.pinned,
                )
            )
            for day in range(start_day, end_day + 1):
                overlap = min(placed.end, timeline.cum[day + 1]) - max(
                    placed.start, timeline.cum[day]
                )
                if overlap > 0:
                    load[(placed.work_center, day)] += overlap
        last_day = max(last_day, end_day)
        days_late = max(0, end_day - day_index(request.start_date, order.due_date))
        results.append(
            OrderResult(
                order_no=order.order_no,
                due_date=order.due_date,
                completion_date=request.start_date + timedelta(days=end_day),
                days_late=days_late,
            )
        )

    day_loads = [
        DayLoad(
            work_center=name,
            date=request.start_date + timedelta(days=day),
            load_minutes=load.get((name, day), 0),
            capacity_minutes=timeline.minutes[day],
        )
        for name, timeline in timelines.items()
        for day in range(min(last_day + 1, timeline.days))
        if timeline.minutes[day] or load.get((name, day))
    ]

    return ScheduleResponse(
        status=status,
        operations=operations,
        orders=results,
        load=day_loads,
        conflicts=conflicts or [],
        total_days_late=sum(r.days_late for r in results),
    )


class _StallStop(cp_model.CpSolverSolutionCallback):
    """Stops the search once it has gone STALL_S seconds without a better plan.
    The lower bound on this objective is weak, so CP-SAT rarely proves
    optimality; waiting for the full time limit buys almost nothing."""

    def __init__(self, solver: cp_model.CpSolver):
        super().__init__()
        self._solver = solver
        self._last: float | None = None  # no plan yet: wait for the time limit
        self._done = threading.Event()

    def on_solution_callback(self) -> None:
        self._last = time.monotonic()

    def watch(self) -> None:
        while not self._done.wait(0.1):
            if self._last is not None and time.monotonic() - self._last > STALL_S:
                self._solver.stop_search()
                return

    def finish(self) -> None:
        self._done.set()


def _solve_until_stalled(solver: cp_model.CpSolver, model: cp_model.CpModel):
    callback = _StallStop(solver)
    watcher = threading.Thread(target=callback.watch, daemon=True)
    watcher.start()
    try:
        return solver.solve(model, callback)
    finally:
        callback.finish()
        watcher.join()


def _axis_values(t: Timeline, start: int, minutes: int) -> dict[str, int]:
    """Every model variable of a candidate placed at `start`, for warm starts."""
    end = start + minutes
    sd, ed = t.day_of(start), t.day_of(end - 1)
    return {
        "start": start,
        "end": end,
        "sd": sd,
        "ed": ed,
        "lo_s": t.cum[sd],
        "hi_s": t.cum[sd + 1],
        "lo_e": t.cum[ed],
        "hi_e": t.cum[ed + 1],
        "num_s": (start - t.cum[sd]) * 100 + t.scale100 - 1,
        "num_e": (end - t.cum[ed]) * 100 + t.scale100 - 1,
        "off_s": t.offset(start, sd),
        "off_e": t.offset(end, ed),
    }


def solve_schedule(
    request: ScheduleRequest,
    *,
    lateness_caps: dict[str, int] | None = None,
    keep: dict[tuple[str, int], tuple[str, int]] | None = None,
    first: set[str] | None = None,
    num_workers: int = 8,
) -> ScheduleResponse:
    """Plan every order.

    Internal options for the capacity check: `lateness_caps` forbids orders from
    finishing more days late than given ("without slipping anyone"); `keep`
    and `first` warm-start from an earlier plan (see dispatch)."""
    _validate(request)
    if not request.orders:
        return ScheduleResponse(status="OPTIMAL")

    parts = {p.part_no: p for p in request.parts}
    timelines = _timelines(request)
    greedy = dispatch(request, timelines, parts, keep, first)
    fallback = build_response(request, "HEURISTIC", greedy.placements, timelines)

    def fallback_or(status: str) -> ScheduleResponse:
        if lateness_caps and any(
            r.days_late > lateness_caps.get(r.order_no, r.days_late) for r in fallback.orders
        ):
            return ScheduleResponse(status=status)
        return fallback

    if greedy.conflicts:
        hinted = False
    else:
        hinted = True
        if sum(len(parts[o.part_no].routing) for o in request.orders) > MAX_CP_OPERATIONS:
            # Too big to optimise in the time limit: the dispatch plan is valid.
            return fallback_or("UNKNOWN")

    last_greedy_day = max(
        timelines[p.work_center].day_of(p.end - 1) for p in greedy.placements.values()
    )
    latest_due = max(day_index(request.start_date, o.due_date) for o in request.orders)
    horizon = max(last_greedy_day, latest_due, 0) + 1
    horizon += horizon // 5 + 5
    for timeline in timelines.values():
        timeline.ensure(horizon + 1)
    horizon = min(horizon, min(t.days for t in timelines.values()) - 1)

    pins = {(p.order_no, p.seq): p for p in request.pins}
    model = cp_model.CpModel()
    intervals: dict[str, list[cp_model.IntervalVar]] = defaultdict(list)
    alt_presences: list[cp_model.IntVar] = []
    chosen: dict[tuple[str, int], list[_Candidate]] = {}
    objective = []

    for order in request.orders:
        routing = sorted(parts[order.part_no].routing, key=lambda o: o.seq)
        previous_end_abs: cp_model.IntVar | None = None
        end_day_var: cp_model.IntVar | None = None
        hinted_end_day = 0
        for op in routing:
            key = (order.order_no, op.seq)
            minutes = op.duration(order.qty)
            pin = pins.get(key)
            hint = greedy.placements[key] if hinted else None
            names = [pin.work_center] if pin else candidates(op, timelines)
            op_start_abs = model.new_int_var(0, (horizon + 2) * DAY, f"{key}_sa")
            op_end_abs = model.new_int_var(0, (horizon + 2) * DAY, f"{key}_ea")
            op_end_day = model.new_int_var(0, horizon, f"{key}_ed")
            options: list[_Candidate] = []
            for index, name in enumerate(names):
                t = timelines[name]
                working = [d for d in range(horizon) if t.minutes[d] > 0]
                if not working:
                    continue
                tag = f"{order.order_no}_{op.seq}_{name}"
                total = t.cum[horizon]
                v = {
                    "start": model.new_int_var(0, max(0, total - minutes), f"{tag}_s"),
                    "end": model.new_int_var(minutes, max(minutes, total), f"{tag}_e"),
                }
                presence = model.new_bool_var(f"{tag}_p")
                intervals[name].append(
                    model.new_optional_interval_var(
                        v["start"], minutes, v["end"], presence, f"{tag}_i"
                    )
                )
                day_domain = cp_model.Domain.from_values(working)
                most = max(t.minutes) * 100 + t.scale100
                for var in ("sd", "ed"):
                    v[var] = model.new_int_var_from_domain(day_domain, f"{tag}_{var}")
                for var in ("lo_s", "hi_s", "lo_e", "hi_e"):
                    v[var] = model.new_int_var(0, total, f"{tag}_{var}")
                for var in ("num_s", "num_e"):
                    v[var] = model.new_int_var(0, most, f"{tag}_{var}")
                for var in ("off_s", "off_e"):
                    v[var] = model.new_int_var(0, 2 * DAY, f"{tag}_{var}")

                cum_lo, cum_hi = t.cum[:horizon], t.cum[1 : horizon + 1]
                model.add_element(v["sd"], cum_lo, v["lo_s"])
                model.add_element(v["sd"], cum_hi, v["hi_s"])
                model.add_element(v["ed"], cum_lo, v["lo_e"])
                model.add_element(v["ed"], cum_hi, v["hi_e"])
                model.add(v["start"] >= v["lo_s"])
                model.add(v["start"] < v["hi_s"])
                model.add(v["end"] - 1 >= v["lo_e"])
                model.add(v["end"] - 1 < v["hi_e"])
                # Clock minutes after shift start, rounded up like Timeline.offset.
                model.add(v["num_s"] == (v["start"] - v["lo_s"]) * 100 + t.scale100 - 1)
                model.add(v["num_e"] == (v["end"] - v["lo_e"]) * 100 + t.scale100 - 1)
                model.add_division_equality(v["off_s"], v["num_s"], t.scale100)
                model.add_division_equality(v["off_e"], v["num_e"], t.scale100)

                model.add(op_start_abs == v["sd"] * DAY + v["off_s"]).only_enforce_if(presence)
                model.add(op_end_abs == v["ed"] * DAY + v["off_e"]).only_enforce_if(presence)
                model.add(op_end_day == v["ed"]).only_enforce_if(presence)
                if pin:
                    model.add(v["sd"] == day_index(request.start_date, pin.start_date))
                options.append(_Candidate(name, presence, v["start"], v["end"]))
                if index > 0:
                    alt_presences.append(presence)

                if hint:
                    here = hint.work_center == name
                    values = _axis_values(t, hint.start if here else t.cum[working[0]], minutes)
                    model.add_hint(presence, here)
                    for var, value in values.items():
                        model.add_hint(v[var], value)
                    if here:
                        model.add_hint(op_start_abs, values["sd"] * DAY + values["off_s"])
                        model.add_hint(op_end_abs, values["ed"] * DAY + values["off_e"])
                        model.add_hint(op_end_day, values["ed"])
                        hinted_end_day = values["ed"]

            if not options:
                return ScheduleResponse(
                    status="INFEASIBLE",
                    conflicts=[
                        Conflict(
                            order_no=order.order_no,
                            seq=op.seq,
                            message=(
                                f"None of op {op.seq}'s machines are running in the plan window."
                            ),
                        )
                    ],
                )
            model.add_exactly_one(c.presence for c in options)
            if previous_end_abs is not None:
                model.add(op_start_abs >= previous_end_abs)
            previous_end_abs = op_end_abs
            end_day_var = op_end_day
            chosen[key] = options

        due = day_index(request.start_date, order.due_date)
        late = model.new_int_var(0, horizon + max(0, -due) + 1, f"{order.order_no}_late")
        assert end_day_var is not None
        model.add(late >= end_day_var - due)
        model.add(late >= 0)
        if lateness_caps and order.order_no in lateness_caps:
            model.add(late <= lateness_caps[order.order_no])
        if hinted:
            model.add_hint(late, max(0, hinted_end_day - due))
        objective.append(LATENESS_WEIGHT * (order.priority + 1) * late)
        objective.append(end_day_var)

    for wc_intervals in intervals.values():
        model.add_no_overlap(wc_intervals)
    objective.extend(ALT_MACHINE_PENALTY * p for p in alt_presences)
    model.minimize(sum(objective))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = request.time_limit_s
    solver.parameters.num_workers = num_workers
    if len(chosen) > 300:
        # Presolve on big models costs more than it saves.
        solver.parameters.max_presolve_iterations = 1
        solver.parameters.symmetry_level = 0
    status = _solve_until_stalled(solver, model)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        placements = {}
        for key, options in chosen.items():
            c = next(c for c in options if solver.value(c.presence))
            placements[key] = Placement(
                c.work_center,
                solver.value(c.start),
                solver.value(c.end),
                pinned=key in pins,
            )
        return build_response(request, solver.status_name(status), placements, timelines)

    if greedy.conflicts:
        return ScheduleResponse(status="INFEASIBLE", conflicts=greedy.conflicts)
    if status == cp_model.INFEASIBLE:
        return ScheduleResponse(status="INFEASIBLE")
    # Out of time: the dispatch plan is valid, just not optimised.
    return fallback_or("UNKNOWN")


def order_result(response: ScheduleResponse, order: Order) -> OrderResult | None:
    return next((r for r in response.orders if r.order_no == order.order_no), None)
