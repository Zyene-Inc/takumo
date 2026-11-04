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
from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor

from app.models import (
    CapacityRequest,
    CapacityResponse,
    CostBreakdown,
    Lever,
    Operator,
    Order,
    OrderResult,
    Part,
    ScheduleRequest,
    ScheduleResponse,
    ShiftWindow,
    SlippedOrder,
    WorkCenter,
)
from app.scheduler.calendar import day_index, to_datetime
from app.scheduler.cpsat_model import order_result, solve_schedule
from app.scheduler.staffing import StaffingReport, staff

OVERTIME_FACTOR = 1.25
# Overtime costs this share of the machine rate on top of the normal rate.
OVERTIME_PREMIUM = 0.5
RUSH_PRIORITY = 10
SOLVED = ("OPTIMAL", "FEASIBLE", "HEURISTIC")
PARALLEL_WORKERS = 4
MAX_NAMED_SLIPS = 5
# Machines named in the "not enough people" sentence.
MAX_SHORT_MACHINES = 2
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
        # Clock time: standard minutes ÷ efficiency, as in quotes (app/quote).
        machine += routing.duration(order.qty) / rates[op.work_center].efficiency / 60 * rate
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


def _clock(minute: int) -> str:
    """Clock minutes from midnight as HH:MM (24:00 for midnight at a window's end)."""
    if minute % 1440 == 0 and minute > 0:
        return "24:00"
    minute %= 1440
    return f"{minute // 60:02d}:{minute % 60:02d}"


def _windows_text(windows: list[tuple[int, int]]) -> str:
    return " and ".join(f"{_clock(s)}–{_clock(e)}" for s, e in windows)


def _machine_shifts(wc: WorkCenter, day_start: str) -> list[ShiftWindow]:
    """A machine's running hours as shifts (for a person to cover them)."""
    if wc.shifts:
        return wc.shifts
    hours, minutes = (int(x) for x in day_start.split(":"))
    end = (hours * 60 + minutes + round(wc.hours_per_day * 60)) % 1440
    return [
        ShiftWindow(days=wc.working_days, start=day_start, end=_clock(end).replace("24:00", "00:00"))
    ]


def _short_days(
    report: StaffingReport, machines: set[str], last_day: int, first_day: int = 0
) -> dict[str, int]:
    """For each machine, the first day in [first_day, last_day] it has fewer
    people than hours."""
    found: dict[str, int] = {}
    for name in sorted(machines):
        for day in range(max(0, first_day), min(last_day, report.days - 1) + 1):
            if report.short(name, day):
                found[name] = day
                break
    return found


def _labor_sentence(
    report: StaffingReport,
    request: ScheduleRequest,
    spans: list[tuple[str, int, int]],
) -> str | None:
    """'HAAS-VF2 has people for 8 of its 16 hours on Thu Nov 12: no one
    qualified on it works 15:30–24:00.' For the new order's machines, on a
    day the order could have used them: from when it could start (material)
    to when that operation finished. `spans`: (machine, first day, last day)."""
    short: dict[str, int] = {}
    for name, first, last in spans:
        if name not in short:
            short.update(_short_days(report, {name}, last, first))
    parts = []
    for name in list(dict.fromkeys(n for n, _, _ in spans if n in short))[:MAX_SHORT_MACHINES]:
        day = short[name]
        machine = report.machine_minutes[(name, day)] / 60
        staffed = report.staffed_minutes.get((name, day), 0) / 60
        when = _d(request.start_date + timedelta(days=day))
        gaps = report.uncovered.get((name, day))
        why = (
            f"no one qualified on it is in {_windows_text(gaps)}"
            if gaps
            else "the people qualified on it are needed on other machines too"
        )
        parts.append(
            f"{name} has people for {round(staffed, 1):g} of its {round(machine, 1):g} hours "
            f"on {when}: {why}"
        )
    return "; ".join(parts) + "." if parts else None


def check_capacity(request: CapacityRequest) -> CapacityResponse:
    new = request.new_order
    if any(o.order_no == new.order_no for o in request.orders):
        raise ValueError(f"Order {new.order_no} already exists")
    parts = {p.part_no: p for p in request.parts}
    if new.part_no not in parts:
        raise ValueError(f"Unknown part {new.part_no}")
    part = parts[new.part_no]

    routing_machines = {
        name for op in part.routing for name in [op.work_center, *op.alt_work_centers]
    }
    half_time = max(1.0, request.time_limit_s / 2)
    plain = ScheduleRequest(
        **request.model_dump(exclude={"new_order"}) | {"time_limit_s": half_time}
    )
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
            overtime_operators={
                o.id for o in plain.operators if routing_machines & set(o.work_centers)
            },
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
    look_until = max(
        [day_index(request.start_date, new.due_date)]
        + [day_index(request.start_date, r.completion_date) for r in baseline.orders]
    ) + 14
    short = _short_days(report, routing_machines, look_until) if plain.operators else {}
    extra: Operator | None = None
    if short:
        extra = Operator(
            id=EXTRA_OPERATOR_ID,
            name="another qualified operator",
            work_centers=sorted(short),
            shifts=[
                window
                for name in sorted(short)
                for window in _machine_shifts(rates[name], request.day_start)
            ],
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
            with_new.model_copy(
                update={
                    "orders": [*request.orders, new.model_copy(update={"release_date": None})]
                }
            ),
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
                    f"Run op {op.seq} on {op.work_center} instead of {primary[op.seq]}"
                    for op in alt_ops
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
            extra_cost = sum(
                h * (rates[name].hourly_rate or 0) * OVERTIME_PREMIUM for name, h in hours.items()
            )
            where = ", ".join(f"{h:g} h on {name}" for name, h in sorted(hours.items()))
            who = (
                " and for the people who run them"
                if plain.operators and routing_machines & report.listed
                else ""
            )
            levers.append(
                Lever(
                    kind="overtime",
                    description=(
                        f"Overtime on this part's machines{who} (up to +"
                        f"{round((OVERTIME_FACTOR - 1) * 100)}% hours): "
                        + (where or "no extra hours needed")
                        + "."
                    ),
                    on_time=overtime_new.days_late == 0,
                    completion_date=overtime_new.completion_date,
                    extra_cost=round(extra_cost, 2)
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
        or (
            lv.completion_date is not None
            and lv.completion_date < fit_new.completion_date
        )
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
        first_op = min(
            _ops_for(fit, {new.order_no}), key=lambda op: op.start_at, default=None
        )
        if (
            first_op is not None
            and new.release_date is not None
            and new.release_date > request.start_date
            and first_op.start_date == new.release_date
        ):
            material += f" Work on it can't start before {_d(new.release_date)}."
        context.append(material)
    if not can_take and plain.operators:
        ready = (
            max(0, day_index(request.start_date, new.release_date)) if new.release_date else 0
        )
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


def _better(response: ScheduleResponse, new: Order, fit: OrderResult) -> OrderResult | None:
    """The new order's result in a lever's plan, if that lever helps at all."""
    if response.status not in SOLVED:
        return None
    result = order_result(response, new)
    if result is None:
        return None
    if result.completion_date < fit.completion_date or (
        result.days_late == 0 and fit.days_late > 0
    ):
        return result
    return None


def _explain(
    new: Order,
    can_take: bool,
    fit: OrderResult,
    rush: OrderResult | None,
    slipped: list[SlippedOrder],
    levers: list[Lever],
    cost: CostBreakdown,
    context: list[str] | None = None,
    tried: list[str] | None = None,
) -> str:
    """`context`: material and people sentences, after the yes or no.
    `tried`: the options planned, named when none of them makes the date."""
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
    sentences.extend(context or [])
    if not can_take:
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
            options = list(tried or ["overtime", "splitting the lot"])
            named = (
                options[0]
                if len(options) == 1
                else ", ".join(options[:-1]) + " or " + options[-1]
            )
            sentences.append(
                f"{named[0].upper()}{named[1:]} don't make the date on their own."
                if len(options) > 1
                else f"{named[0].upper()}{named[1:]} doesn't make the date on its own."
            )
    if cost.margin is not None and cost.margin_pct is not None:
        sentences.append(
            f"Estimated cost ${cost.total:,.0f} against ${cost.price:,.0f}: "
            f"{cost.margin_pct:g}% margin."
        )
    return " ".join(sentences)
