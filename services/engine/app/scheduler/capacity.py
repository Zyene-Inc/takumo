"""Capacity check: "Can we take this order?"

1. Plan the shop as it is (baseline).
2. In parallel:
   - fit the new order in without letting any existing order finish later
     than in the baseline → can we take it, and the earliest date;
   - put the new order first → when it would ship and which orders slip;
   - the same "nobody slips" plan with overtime, and with the order split
     into two lots → which levers make it on time, and what they cost.
All numbers come from the solver; the agent only explains them.
"""

import math
from datetime import date
from concurrent.futures import ThreadPoolExecutor

from app.models import (
    CapacityRequest,
    CapacityResponse,
    CostBreakdown,
    Lever,
    Order,
    OrderResult,
    Part,
    ScheduleRequest,
    ScheduleResponse,
    SlippedOrder,
    WorkCenter,
)
from app.scheduler.calendar import to_datetime
from app.scheduler.cpsat_model import order_result, solve_schedule

OVERTIME_FACTOR = 1.25
# Overtime costs this share of the machine rate on top of the normal rate.
OVERTIME_PREMIUM = 0.5
RUSH_PRIORITY = 10
SOLVED = ("OPTIMAL", "FEASIBLE", "HEURISTIC")
PARALLEL_WORKERS = 4
MAX_NAMED_SLIPS = 5


def _keep(response: ScheduleResponse, request: ScheduleRequest):
    """The baseline's machine and start time for every operation (warm start)."""
    origin = to_datetime(request.start_date, request.day_start, 0)
    return {
        (op.order_no, op.seq): (
            op.work_center,
            int((op.start_at - origin).total_seconds() // 60),
        )
        for op in response.operations
    }


def _late(response: ScheduleResponse) -> dict[str, int]:
    return {r.order_no: r.days_late for r in response.orders}


def _ops_for(response: ScheduleResponse, order_nos: set[str]):
    return [op for op in response.operations if op.order_no in order_nos]


def order_cost(
    order: Order, part: Part, response: ScheduleResponse, rates: dict[str, WorkCenter]
) -> CostBreakdown:
    """Machine time at each machine's rate + material, from where the plan put it."""
    missing: list[str] = []
    machine = 0.0
    for op in _ops_for(response, {order.order_no}):
        rate = rates[op.work_center].hourly_rate
        if rate is None:
            missing.append(f"hourly rate for {op.work_center}")
            continue
        routing = next(r for r in part.routing if r.seq == op.seq)
        machine += routing.duration(order.qty) / 60 * rate
    material = None
    if part.material_cost is None:
        missing.append(f"material cost for {part.part_no}")
    else:
        material = part.material_cost * order.qty
    total = None if missing else round(machine + (material or 0), 2)
    price = order.price
    margin = round(price - total, 2) if price is not None and total is not None else None
    return CostBreakdown(
        machine=round(machine, 2) if not any("rate" in m for m in missing) else None,
        material=round(material, 2) if material is not None else None,
        total=total,
        price=price,
        margin=margin,
        margin_pct=round(margin / price * 100, 1) if margin is not None and price else None,
        missing=missing,
    )


def with_overtime(request: ScheduleRequest, machines: set[str]) -> ScheduleRequest:
    """More hours on the given machines only (working days and extra shifts)."""

    def longer(wc: WorkCenter) -> WorkCenter:
        if wc.name not in machines:
            return wc
        return wc.model_copy(
            update={
                "hours_per_day": min(24.0, wc.hours_per_day * OVERTIME_FACTOR),
                "exceptions": [
                    e.model_copy(update={"hours": min(24.0, e.hours * OVERTIME_FACTOR)})
                    for e in wc.exceptions
                ],
            }
        )

    return request.model_copy(update={"work_centers": [longer(wc) for wc in request.work_centers]})


def overtime_hours(
    overtime: ScheduleResponse, request: ScheduleRequest, until: date
) -> dict[str, float]:
    """Clock hours above normal capacity, per machine, in the overtime plan, up to
    the day the new order finishes (overtime after that isn't needed for it)."""
    wcs = {wc.name: wc for wc in request.work_centers}
    extra: dict[str, float] = {}
    for day in overtime.load:
        if day.date > until:
            continue
        normal = round(
            wcs[day.work_center].hours_on(day.date)
            * 60
            * wcs[day.work_center].efficiency
            * request.capacity_factor
        )
        over = day.load_minutes - normal
        if over > 0:
            hours = over / 60 / (wcs[day.work_center].efficiency * request.capacity_factor)
            extra[day.work_center] = extra.get(day.work_center, 0) + hours
    return {name: round(h, 1) for name, h in extra.items() if h >= 0.1}


def _slips(before: dict[str, int], after: dict[str, int], new_nos: set[str]):
    return [
        SlippedOrder(order_no=no, days_late_before=before.get(no, 0), days_late_after=late)
        for no, late in after.items()
        if no not in new_nos and late > before.get(no, 0)
    ]


def _d(day: date) -> str:
    """Tue Nov 10: how a planner reads a date."""
    return f"{day:%a %b} {day.day}"


def _days(n: int) -> str:
    return f"{n} day{'s' if n != 1 else ''}"


def check_capacity(request: CapacityRequest) -> CapacityResponse:
    new = request.new_order
    if any(o.order_no == new.order_no for o in request.orders):
        raise ValueError(f"Order {new.order_no} already exists")
    parts = {p.part_no: p for p in request.parts}
    if new.part_no not in parts:
        raise ValueError(f"Unknown part {new.part_no}")
    part = parts[new.part_no]
    rates = {wc.name: wc for wc in request.work_centers}

    routing_machines = {
        name for op in part.routing for name in [op.work_center, *op.alt_work_centers]
    }
    base_request = ScheduleRequest(**request.model_dump(exclude={"new_order"}))
    with_new = base_request.model_copy(update={"orders": [*request.orders, new]})

    baseline = solve_schedule(base_request)
    if baseline.status not in SOLVED:
        return CapacityResponse(
            status=baseline.status,
            can_take=False,
            explanation=(
                "The current plan can't be built "
                f"({'; '.join(c.message for c in baseline.conflicts) or baseline.status}). "
                "Fix the schedule board first."
            ),
        )
    before = _late(baseline)
    caps = dict(before)
    keep = _keep(baseline, base_request)

    half = new.qty // 2
    split_orders = [
        new.model_copy(update={"order_no": f"{new.order_no}-A", "qty": new.qty - half}),
        new.model_copy(update={"order_no": f"{new.order_no}-B", "qty": half}),
    ]
    jobs = {
        "fit": (with_new, caps, keep),
        "rush": (
            base_request.model_copy(
                update={
                    "orders": [
                        *request.orders,
                        new.model_copy(update={"priority": RUSH_PRIORITY}),
                    ]
                }
            ),
            None,
            keep,
        ),
        "overtime": (
            with_overtime(with_new, routing_machines),
            caps,
            keep,
        ),
    }
    if half > 0:
        jobs["split"] = (
            base_request.model_copy(update={"orders": [*request.orders, *split_orders]}),
            caps,
            keep,
        )
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {
            name: pool.submit(
                solve_schedule,
                req,
                lateness_caps=lat,
                keep=kept,
                first={new.order_no} if name == "rush" else None,
                num_workers=PARALLEL_WORKERS,
            )
            for name, (req, lat, kept) in jobs.items()
        }
        results = {name: f.result() for name, f in futures.items()}

    fit, rush = results["fit"], results["rush"]
    if fit.status not in SOLVED:
        # Can't happen: the baseline with the new order fitted into its gaps is
        # always a valid answer (and is returned when the solver runs out of time).
        return CapacityResponse(
            status=fit.status,
            can_take=False,
            explanation="The scheduler could not fit the new order in.",
        )
    fit_new = order_result(fit, new)
    rush_new = order_result(rush, new)
    if fit_new is None:
        return CapacityResponse(
            status=fit.status,
            can_take=False,
            explanation="The scheduler could not place the new order.",
        )
    can_take = fit_new.days_late == 0 and not _slips(before, _late(fit), {new.order_no})
    slipped = _slips(before, _late(rush), {new.order_no}) if rush.status in SOLVED else []
    cost = order_cost(new, part, fit, rates)

    levers: list[Lever] = []
    primary = {op.seq: op.work_center for op in part.routing}
    alt_ops = [op for op in _ops_for(fit, {new.order_no}) if op.work_center != primary[op.seq]]
    if alt_ops:
        levers.append(
            Lever(
                kind="alternate_machine",
                description="; ".join(
                    f"Run op {op.seq} on {op.work_center} instead of {primary[op.seq]}"
                    for op in alt_ops
                )
                + ".",
                on_time=fit_new.days_late == 0,
                completion_date=fit_new.completion_date,
                extra_cost=None,
            )
        )

    if not can_take:
        overtime = results["overtime"]
        overtime_new = order_result(overtime, new) if overtime.status in SOLVED else None
        if overtime_new:
            hours = overtime_hours(overtime, base_request, overtime_new.completion_date)
            extra = sum(
                h * (rates[name].hourly_rate or 0) * OVERTIME_PREMIUM for name, h in hours.items()
            )
            where = ", ".join(f"{h:g} h on {name}" for name, h in sorted(hours.items()))
            levers.append(
                Lever(
                    kind="overtime",
                    description=(
                        f"Overtime on this part's machines (up to +"
                        f"{round((OVERTIME_FACTOR - 1) * 100)}% hours): "
                        + (where or "no extra hours needed")
                        + "."
                    ),
                    on_time=overtime_new.days_late == 0,
                    completion_date=overtime_new.completion_date,
                    extra_cost=round(extra, 2)
                    if all(rates[n].hourly_rate is not None for n in hours)
                    else None,
                )
            )
        split = results.get("split")
        split_results = (
            [order_result(split, o) for o in split_orders]
            if split and split.status in SOLVED
            else []
        )
        if split_results and all(split_results):
            last = max(split_results, key=lambda r: r.completion_date)
            first = min(split_results, key=lambda r: r.completion_date)
            rated = all(rates[op.work_center].hourly_rate is not None for op in part.routing)
            levers.append(
                Lever(
                    kind="split_lot",
                    description=(
                        f"Split into two lots of {new.qty - half} and {half}: "
                        f"first lot done {_d(first.completion_date)}, second {_d(last.completion_date)}."
                    ),
                    on_time=all(r.days_late == 0 for r in split_results),
                    completion_date=last.completion_date,
                    extra_cost=round(
                        sum(
                            op.setup_min / 60 * (rates[op.work_center].hourly_rate or 0)
                            for op in part.routing
                        ),
                        2,
                    )
                    if rated
                    else None,
                )
            )

    # Cheapest on-time lever first.
    levers.sort(
        key=lambda lv: (
            not lv.on_time,
            math.inf if lv.extra_cost is None else lv.extra_cost,
        )
    )

    explanation = _explain(new, can_take, fit_new, rush_new, slipped, levers, cost)
    return CapacityResponse(
        status=fit.status,
        can_take=can_take,
        new_order=fit_new,
        rush=rush_new,
        slipped=slipped,
        levers=levers,
        cost=cost,
        explanation=explanation,
    )


def _explain(
    new: Order,
    can_take: bool,
    fit: OrderResult,
    rush: OrderResult | None,
    slipped: list[SlippedOrder],
    levers: list[Lever],
    cost: CostBreakdown,
) -> str:
    sentences: list[str] = []
    if can_take:
        sentences.append(
            f"Yes. {new.qty:,} × {new.part_no} can finish {_d(fit.completion_date)} "
            f"(due {_d(fit.due_date)}) without moving any existing order."
        )
    else:
        sentences.append(
            f"Not without changes. Fitted around today's orders, {new.part_no} finishes "
            f"{_d(fit.completion_date)}, {_days(fit.days_late)} after the {_d(fit.due_date)} due date."
        )
        if rush and rush.days_late == 0 and slipped:
            worst = sorted(
                slipped, key=lambda s: s.days_late_before - s.days_late_after
            )[:MAX_NAMED_SLIPS]
            more = len(slipped) - len(worst)
            sentences.append(
                f"Putting it first makes the date ({_d(rush.completion_date)}) but pushes back "
                + ", ".join(
                    f"{s.order_no} (+{_days(s.days_late_after - s.days_late_before)})"
                    for s in worst
                )
                + (f" and {more} more" if more else "")
                + "."
            )
        elif rush and rush.days_late > 0:
            sentences.append(
                f"Even going first it finishes {_d(rush.completion_date)} "
                f"({_days(rush.days_late)} late)."
            )
        best = next((lv for lv in levers if lv.on_time), None)
        if best:
            price = (
                f" for about ${best.extra_cost:,.0f} extra" if best.extra_cost else ""
            )
            sentences.append(
                f"Cheapest way to make the date: {best.description[0].lower()}"
                f"{best.description[1:].rstrip('.')}{price}."
            )
        else:
            sentences.append("Overtime and splitting the lot don't make the date on their own.")
    if cost.margin is not None and cost.margin_pct is not None:
        sentences.append(
            f"Estimated cost ${cost.total:,.0f} against ${cost.price:,.0f}: "
            f"{cost.margin_pct:g}% margin."
        )
    return " ".join(sentences)
