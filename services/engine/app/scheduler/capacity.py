"""Capacity check: "Can we take this order?"

1. Plan the shop as it is (baseline).
2. In parallel:
   - fit the new order in without letting any existing order finish later
     than in the baseline → can we take it, and the earliest date;
   - put the new order first → when it would ship and which orders slip;
   - the same "nobody slips" plan with overtime, and with the order split
     into two lots → which levers make it on time, and what they cost.
3. When it's late: the same plan with another qualified person on the
   machines short of people, and with the material in today → whether hiring
   in or expediting would make the date.

With operators, the shop is staffed once (staffing.py), weighted by the
orders including the new one, and every variant above plans on that same
staffed shop, so "nobody slips" compares like with like. Overtime and the
extra person re-staff with more supply, which only ever adds hours.
Time: the baseline gets half the request's time limit and the variants,
which run in parallel, the other half, so the whole check stays near the
limit (F3.3-R6). When the baseline couldn't be optimised in its half (a big
shop: CP-SAT found nothing in time and the dispatch plan stood), the
variants go straight to dispatch: they'd have waited out their time to the
same result.
All numbers come from the solver; the agent only explains them.
"""

import math
from concurrent.futures import ThreadPoolExecutor

from app.models import (
    CapacityRequest,
    CapacityResponse,
    Lever,
    Operator,
    ScheduleRequest,
    ScheduleResponse,
    SlippedOrder,
)
from app.scheduler.calendar import day_index, to_datetime
from app.scheduler.capacity_explain import (
    SOLVED,
    _better,
    _d,
    _explain,
    _labor_sentence,
    _machine_shifts,
    _short_days,
    _windows_text,
)
from app.scheduler.capacity_levers import (
    OVERTIME_FACTOR,
    OVERTIME_PREMIUM,
    _ops_for,
    order_cost,
    overtime_hours,
    with_overtime,
)
from app.scheduler.cpsat_model import order_result, solve_schedule
from app.scheduler.staffing import staff

RUSH_PRIORITY = 10
PARALLEL_WORKERS = 4
EXTRA_OPERATOR_ID = "extra"


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


def _slips(before: dict[str, int], after: dict[str, int], new_nos: set[str]):
    return [
        SlippedOrder(order_no=no, days_late_before=before.get(no, 0), days_late_after=late)
        for no, late in after.items()
        if no not in new_nos and late > before.get(no, 0)
    ]


def check_capacity(request: CapacityRequest) -> CapacityResponse:
    new = request.new_order
    if any(o.order_no == new.order_no for o in request.orders):
        raise ValueError(f"Order {new.order_no} already exists")
    parts = {p.part_no: p for p in request.parts}
    if new.part_no not in parts:
        raise ValueError(f"Unknown part {new.part_no}")
    part = parts[new.part_no]

    routing_machines = {name for op in part.routing for name in [op.work_center, *op.alt_work_centers]}
    half_time = max(1.0, request.time_limit_s / 2)
    plain = ScheduleRequest(**request.model_dump(exclude={"new_order"}) | {"time_limit_s": half_time})
    plain_with_new = plain.model_copy(update={"orders": [*request.orders, new]})
    # Staffed once, weighted by the orders including the new one (see above).
    with_new, report = staff(plain_with_new)
    base_request = with_new.model_copy(update={"orders": list(request.orders)})
    rates = {wc.name: wc for wc in base_request.work_centers}

    baseline = solve_schedule(base_request)
    # CP-SAT found nothing in time: the variants won't either.
    dispatch_only = baseline.status == "HEURISTIC"
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
    if plain.operators:
        # More hours on the machines and for the people who run them.
        overtime_request, _ = staff(
            with_overtime(plain_with_new, routing_machines),
            weights_from=plain_with_new,
            overtime_operators={o.id for o in plain.operators if routing_machines & set(o.work_centers)},
            overtime_factor=OVERTIME_FACTOR,
        )
    else:
        overtime_request = with_overtime(with_new, routing_machines)
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
        "overtime": (overtime_request, caps, keep),
    }
    if half > 0:
        jobs["split"] = (
            base_request.model_copy(update={"orders": [*request.orders, *split_orders]}),
            caps,
            keep,
        )

    # Only used when the order is late, but planned now, alongside the rest,
    # so a "no" costs one round of solving, not two.
    look_until = (
        max(
            [day_index(request.start_date, new.due_date)]
            + [day_index(request.start_date, r.completion_date) for r in baseline.orders]
        )
        + 14
    )
    short = _short_days(report, routing_machines, look_until) if plain.operators else {}
    extra: Operator | None = None
    if short:
        extra = Operator(
            id=EXTRA_OPERATOR_ID,
            name="another qualified operator",
            work_centers=sorted(short),
            shifts=[window for name in sorted(short) for window in _machine_shifts(rates[name], request.day_start)],
        )
        extra_request, _ = staff(
            plain_with_new.model_copy(update={"operators": [*plain.operators, extra]}),
            weights_from=plain_with_new,
            extra_last={EXTRA_OPERATOR_ID},
        )
        jobs["extra_operator"] = (extra_request, caps, keep)
    late_material = new.release_date is not None and new.release_date > request.start_date
    if late_material:
        jobs["expedite_material"] = (
            with_new.model_copy(update={"orders": [*request.orders, new.model_copy(update={"release_date": None})]}),
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
                dispatch_only=dispatch_only,
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
                    f"Run op {op.seq} on {op.work_center} instead of {primary[op.seq]}" for op in alt_ops
                )
                + ".",
                on_time=fit_new.days_late == 0,
                completion_date=fit_new.completion_date,
                extra_cost=None,
            )
        )

    tried: list[str] = []
    if not can_take:
        tried = ["overtime"] + (["splitting the lot"] if half > 0 else [])
        overtime = results["overtime"]
        overtime_new = order_result(overtime, new) if overtime.status in SOLVED else None
        if overtime_new:
            hours = overtime_hours(overtime, base_request, overtime_new.completion_date)
            extra_cost = sum(h * (rates[name].hourly_rate or 0) * OVERTIME_PREMIUM for name, h in hours.items())
            where = ", ".join(f"{h:g} h on {name}" for name, h in sorted(hours.items()))
            who = " and for the people who run them" if plain.operators and routing_machines & report.listed else ""
            levers.append(
                Lever(
                    kind="overtime",
                    description=(
                        f"Overtime on this part's machines{who} (up to +"
                        f"{round((OVERTIME_FACTOR - 1) * 100)}% hours): " + (where or "no extra hours needed") + "."
                    ),
                    on_time=overtime_new.days_late == 0,
                    completion_date=overtime_new.completion_date,
                    extra_cost=round(extra_cost, 2) if all(rates[n].hourly_rate is not None for n in hours) else None,
                )
            )
        split = results.get("split")
        split_results = [order_result(split, o) for o in split_orders] if split and split.status in SOLVED else []
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
                        sum(op.setup_min / 60 * (rates[op.work_center].hourly_rate or 0) for op in part.routing),
                        2,
                    )
                    if rated
                    else None,
                )
            )
        if extra is not None:
            tried.append("another person")
            lever = _better(results["extra_operator"], new, fit_new)
            if lever:
                first_short = sorted(short, key=lambda n: (short[n], n))[0]
                gaps = report.uncovered.get((first_short, short[first_short]))
                working = f" working {_windows_text(gaps)}" if gaps else ""
                levers.append(
                    Lever(
                        kind="extra_operator",
                        description=(
                            f"Another person qualified on {', '.join(sorted(short))}{working}: "
                            f"done {_d(lever.completion_date)}."
                        ),
                        on_time=lever.days_late == 0,
                        completion_date=lever.completion_date,
                        # What a person costs isn't in the request: not guessed.
                        extra_cost=None,
                    )
                )
        if late_material:
            assert new.release_date is not None
            tried.append("faster material")
            lever = _better(results["expedite_material"], new, fit_new)
            if lever:
                levers.append(
                    Lever(
                        kind="expedite_material",
                        description=(
                            f"Expedite the material: if it came today instead of "
                            f"{_d(new.release_date)}, it would be done {_d(lever.completion_date)}."
                        ),
                        on_time=lever.days_late == 0,
                        completion_date=lever.completion_date,
                        extra_cost=None,
                    )
                )

    # Only ways that help: on time, or at least sooner than fitting it in as
    # it is. Overtime or a split that changes nothing (the machine has no
    # people, the material isn't in) would only be noise.
    levers = [
        lv
        for lv in levers
        if lv.on_time
        or lv.kind == "alternate_machine"
        or (lv.completion_date is not None and lv.completion_date < fit_new.completion_date)
    ]

    # Cheapest on-time lever first.
    levers.sort(
        key=lambda lv: (
            not lv.on_time,
            math.inf if lv.extra_cost is None else lv.extra_cost,
        )
    )

    context: list[str] = []
    if new.release_note:
        material = f"Material: {new.release_note.rstrip('.')}."
        first_op = min(_ops_for(fit, {new.order_no}), key=lambda op: op.start_at, default=None)
        if (
            first_op is not None
            and new.release_date is not None
            and new.release_date > request.start_date
            and first_op.start_date == new.release_date
        ):
            material += f" Work on it can't start before {_d(new.release_date)}."
        context.append(material)
    if not can_take and plain.operators:
        ready = max(0, day_index(request.start_date, new.release_date)) if new.release_date else 0
        spans = [
            (op.work_center, ready, day_index(request.start_date, op.end_date))
            for op in sorted(_ops_for(fit, {new.order_no}), key=lambda o: o.seq)
        ]
        labor = _labor_sentence(report, request, spans)
        if labor:
            context.append(labor)

    explanation = _explain(new, can_take, fit_new, rush_new, slipped, levers, cost, context, tried)
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
