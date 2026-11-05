"""The capacity answer in words: dates, short machines, labor and the better lever."""

from datetime import date, timedelta

from app.models import (
    CostBreakdown,
    Lever,
    Order,
    OrderResult,
    ScheduleRequest,
    ScheduleResponse,
    ShiftWindow,
    SlippedOrder,
    WorkCenter,
)
from app.scheduler.cpsat_model import order_result
from app.scheduler.staffing import StaffingReport

SOLVED = ("OPTIMAL", "FEASIBLE", "HEURISTIC")


MAX_NAMED_SLIPS = 5


# Machines named in the "not enough people" sentence.
MAX_SHORT_MACHINES = 2


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
    return [ShiftWindow(days=wc.working_days, start=day_start, end=_clock(end).replace("24:00", "00:00"))]


def _short_days(report: StaffingReport, machines: set[str], last_day: int, first_day: int = 0) -> dict[str, int]:
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
        parts.append(f"{name} has people for {round(staffed, 1):g} of its {round(machine, 1):g} hours on {when}: {why}")
    return "; ".join(parts) + "." if parts else None


def _better(response: ScheduleResponse, new: Order, fit: OrderResult) -> OrderResult | None:
    """The new order's result in a lever's plan, if that lever helps at all."""
    if response.status not in SOLVED:
        return None
    result = order_result(response, new)
    if result is None:
        return None
    if result.completion_date < fit.completion_date or (result.days_late == 0 and fit.days_late > 0):
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
            worst = sorted(slipped, key=lambda s: s.days_late_before - s.days_late_after)[:MAX_NAMED_SLIPS]
            more = len(slipped) - len(worst)
            sentences.append(
                f"Putting it first makes the date ({_d(rush.completion_date)}) but pushes back "
                + ", ".join(f"{s.order_no} (+{_days(s.days_late_after - s.days_late_before)})" for s in worst)
                + (f" and {more} more" if more else "")
                + "."
            )
        elif rush and rush.days_late > 0:
            sentences.append(f"Even going first it finishes {_d(rush.completion_date)} ({_days(rush.days_late)} late).")
        best = next((lv for lv in levers if lv.on_time), None)
        if best:
            price = f" for about ${best.extra_cost:,.0f} extra" if best.extra_cost else ""
            sentences.append(
                f"Cheapest way to make the date: {best.description[0].lower()}"
                f"{best.description[1:].rstrip('.')}{price}."
            )
        else:
            options = list(tried or ["overtime", "splitting the lot"])
            named = options[0] if len(options) == 1 else ", ".join(options[:-1]) + " or " + options[-1]
            sentences.append(
                f"{named[0].upper()}{named[1:]} don't make the date on their own."
                if len(options) > 1
                else f"{named[0].upper()}{named[1:]} doesn't make the date on its own."
            )
    if cost.margin is not None and cost.margin_pct is not None:
        sentences.append(f"Estimated cost ${cost.total:,.0f} against ${cost.price:,.0f}: {cost.margin_pct:g}% margin.")
    return " ".join(sentences)
