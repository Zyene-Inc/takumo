"""Staffing: machines run only while someone qualified is there (F3.1, F3.3).

Each day, every operator's shift minutes are shared out over the machines
they're qualified on, and a machine's hours that day become what its people
cover. The result is a plain ScheduleRequest whose work centers carry those
hours as day exceptions, so the solver (calendar.py axes, CP-SAT, dispatch)
needs no new variables and stays as fast as before (F3.3-R6).

This is the "operator capacity per qualification group" model of v1: people
are pooled per day and split between machines, never booked twice; named
assignments (who runs which job) are v2.

Rules, in the order they apply:

- Machine clock windows on a day: its `shifts` on that weekday; with no
  shifts, one window from the plan's `day_start` lasting `hours_on(day)`.
  A day exception (holiday, maintenance, short day) always wins: the window
  is then `day_start` + the exception's hours. The minutes counted never
  exceed `hours_on(day)` (the engine's own capacity for the day).
- Operator clock windows: their `shifts` on that weekday. An operator with no
  shifts works "any time": during every window of the machines they're
  qualified on that day (the union, so they're never in two places at once).
  Time off: 0 hours = off that day; more = their windows cut to that many
  hours from the start of the day's first window.
- A window whose end is at or before its start runs past midnight; it
  belongs to the day it starts. Overnight operator windows from the day
  before count toward the next morning's machine windows.
- Demand weights: every order operation's standard minutes go to its primary
  machine in full, and to each alternate at 1 / (1 + number of alternates).
- Per day, operators with the fewest qualified machines go first (ties by
  id). Each one's minutes are spread over their machines that still need
  people, in proportion to the weights, each capped by how much of the
  operator's windows overlap the machine's windows and by what the machine
  still needs (its minutes × operators_per_machine). Machines with no demand
  only get what's left over, equally. A machine's staffed minutes are what
  it was given ÷ operators_per_machine, never more than its own minutes, and
  never more than the minutes its windows have enough qualified people in at
  once (two people on the same two hours of a one-person machine still give
  two hours; a machine needing two people needs two in at the same time).
- A machine marked `unattended_runs` is fully staffed on a day when an
  operator qualified on it who can leave machines running (`unattended`)
  works that day. Setup minutes aren't deducted from that operator (v1).
- A machine no operator lists keeps its own hours (unchecked) and gets a
  notice. No operators at all: nothing changes and there are no notices.
- `capacity_factor` scales people as it scales machines (the calendar applies
  it to the resulting hours). Overtime operators' minutes are multiplied by
  the overtime factor: they stay later, as an overtime machine does (its last
  window is extended), so their windows on the clock grow too.
- The days covered run from the plan start to the later of HORIZON_DAYS and
  120 days after the last due or release date (capped at the calendar's
  MAX_DAYS). Days after that keep the machines' own hours.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from app.models import DayException, Operator, ScheduleRequest
from app.scheduler.calendar import DAY
from app.scheduler.staffing_crews import _operator_windows, _Person, _staff_day
from app.scheduler.staffing_windows import (
    HORIZON_DAYS,  # noqa: F401  (re-exported: callers read it from here)
    Window,
    _horizon,
    _machine_windows,
    _minute,
    _weights,
)


@dataclass
class StaffingReport:
    """What staffing found, for the response and for explanations."""

    # (work center, day index) → clock minutes, only for days with machine hours.
    machine_minutes: dict[tuple[str, int], float] = field(default_factory=dict)
    staffed_minutes: dict[tuple[str, int], float] = field(default_factory=dict)
    # (work center, day index) → machine windows no qualified operator works
    # at all, as clock minutes from that day's midnight.
    uncovered: dict[tuple[str, int], list[Window]] = field(default_factory=dict)
    notices: list[str] = field(default_factory=list)
    # Machines at least one operator lists (the ones staffing limits).
    listed: set[str] = field(default_factory=set)
    # (work center, day index) → the stretches it's covered, in clock minutes
    # from the plan start's midnight, with who covers each (assign.py names
    # them on the plan's operations). Lights-out days: its windows, nobody.
    crews: dict[tuple[str, int], list[tuple[int, int, tuple[str, ...]]]] = field(default_factory=dict)
    lights_out: set[tuple[str, int]] = field(default_factory=set)
    # The roster after staffing: what's left of each person's time.
    people: dict[str, "_Person"] = field(default_factory=dict)
    days: int = 0

    def short(self, work_center: str, day: int) -> bool:
        machine = self.machine_minutes.get((work_center, day), 0)
        return machine > 0 and self.staffed_minutes.get((work_center, day), machine) < machine - 0.5


def staff(
    request: ScheduleRequest,
    *,
    weights_from: ScheduleRequest | None = None,
    overtime_operators: set[str] | None = None,
    overtime_factor: float = 1.0,
    extra_last: set[str] | None = None,
) -> tuple[ScheduleRequest, StaffingReport]:
    """The request with machines' hours cut to what their people cover.

    `weights_from` is the order set whose demand decides how shared people
    are split (default: the request's own); a capacity check passes the set
    including the new order to every variant, so all its plans compare like
    with like. Operators in `extra_last` are placed after everyone else (a
    person added to see what they'd change), so the others' split stays as it
    was and the newcomer only adds hours. The returned request has no
    operators (it's already staffed).
    """
    report = StaffingReport()
    if not request.operators:
        return request, report

    names = {wc.name for wc in request.work_centers}
    operators = sorted(request.operators, key=lambda o: o.id)
    qualified: dict[str, list[Operator]] = defaultdict(list)
    for operator in operators:
        for name in dict.fromkeys(operator.work_centers):
            if name in names:
                qualified[name].append(operator)
    report.listed = set(qualified)
    for wc in request.work_centers:
        if wc.name not in qualified:
            report.notices.append(f"No operator is listed for {wc.name}, so its hours aren't checked against people.")

    weight = _weights(weights_from or request)
    day_start = _minute(request.day_start)
    days = _horizon(request)
    report.days = days
    wcs = {wc.name: wc for wc in request.work_centers}
    overtime = overtime_operators or set()
    people = [
        _Person(
            o,
            [n for n in dict.fromkeys(o.work_centers) if n in names],
            overtime_factor if o.id in overtime else 1.0,
        )
        for o in operators
    ]
    # Fewest machines first: the people with the least choice get placed first.
    last = extra_last or set()
    order = sorted(people, key=lambda p: (p.operator.id in last, len(p.machines), p.operator.id))
    staffed_hours: dict[str, dict[date, float]] = defaultdict(dict)
    # Most days are like an earlier one (the same weekday shifts, the same
    # night before): their outcome is worked out once and moved to the date.
    seen: dict[tuple, dict] = {}

    for d in range(-1, days):
        day = request.start_date + timedelta(days=d)
        offset = d * DAY
        machine_windows = {name: _machine_windows(wc, day, offset, day_start) for name, wc in wcs.items()}
        for person in people:
            windows = _operator_windows(person, day, offset, machine_windows)
            person.open_day(d, windows)
        if d < 0:
            continue
        key = _day_key(d, machine_windows, order)
        known = seen.get(key)
        if known is not None:
            _replay(known, d, day, order, report, staffed_hours)
            continue
        _staff_day(d, day, wcs, machine_windows, qualified, order, weight, report, staffed_hours)
        seen[key] = _capture(d, day, machine_windows, order, report, staffed_hours)
    report.people = {p.operator.id: p for p in people}
    _never_staffed(request, qualified, weight, report, staffed_hours)

    staffed_wcs = []
    for wc in request.work_centers:
        cut = staffed_hours.get(wc.name)
        if not cut:
            staffed_wcs.append(wc)
            continue
        kept = [e for e in wc.exceptions if e.date not in cut]
        added = [DayException(date=day, hours=hours, reason="staffing") for day, hours in sorted(cut.items())]
        staffed_wcs.append(wc.model_copy(update={"exceptions": kept + added}))
    staffed = request.model_copy(update={"work_centers": staffed_wcs, "operators": []})
    return staffed, report


def _day_key(d: int, machine_windows: dict[str, list[Window]], order: list[_Person]) -> tuple:
    """Everything a day's staffing depends on that changes from day to day,
    relative to that day's midnight."""
    offset = d * DAY
    return (
        tuple((name, tuple((s - offset, e - offset) for s, e in w)) for name, w in machine_windows.items()),
        tuple(
            (
                tuple((s - offset, e - offset) for dd in (d - 1, d) for s, e in p.windows.get(dd, [])),
                tuple((s - offset, e - offset, round(f, 6)) for dd in (d - 1, d) for s, e, f in p.spans.get(dd, [])),
            )
            for p in order
        ),
    )


def _capture(
    d: int,
    day: date,
    machine_windows: dict[str, list[Window]],
    order: list[_Person],
    report: StaffingReport,
    staffed_hours: dict[str, dict[date, float]],
) -> dict:
    offset = d * DAY
    names = [n for n in machine_windows if (n, d) in report.machine_minutes]
    return {
        "machine": {n: report.machine_minutes[(n, d)] for n in names},
        "staffed": {n: report.staffed_minutes[(n, d)] for n in names if (n, d) in report.staffed_minutes},
        "crews": {
            n: [(s - offset, e - offset, crew) for s, e, crew in report.crews[(n, d)]]
            for n in names
            if (n, d) in report.crews
        },
        "lights_out": {n for n in names if (n, d) in report.lights_out},
        "uncovered": {n: report.uncovered[(n, d)] for n in names if (n, d) in report.uncovered},
        "hours": {n: h[day] for n, h in staffed_hours.items() if day in h},
        "spans": [
            {dd - d: [(s - offset, e - offset, f) for s, e, f in p.spans.get(dd, [])] for dd in (d - 1, d)}
            for p in order
        ],
    }


def _replay(
    known: dict,
    d: int,
    day: date,
    order: list[_Person],
    report: StaffingReport,
    staffed_hours: dict[str, dict[date, float]],
) -> None:
    offset = d * DAY
    for n, minutes in known["machine"].items():
        report.machine_minutes[(n, d)] = minutes
    for n, minutes in known["staffed"].items():
        report.staffed_minutes[(n, d)] = minutes
    for n, crews in known["crews"].items():
        report.crews[(n, d)] = [(s + offset, e + offset, crew) for s, e, crew in crews]
    for n in known["lights_out"]:
        report.lights_out.add((n, d))
    for n, gaps in known["uncovered"].items():
        report.uncovered[(n, d)] = gaps
    for n, hours in known["hours"].items():
        staffed_hours[n][day] = hours
    for person, spans in zip(order, known["spans"], strict=False):
        for rel, kept in spans.items():
            if d + rel in person.spans:
                person.spans[d + rel] = [[s + offset, e + offset, f] for s, e, f in kept]


def _never_staffed(
    request: ScheduleRequest,
    qualified: dict[str, list[Operator]],
    weight: dict[str, float],
    report: StaffingReport,
    staffed_hours: dict[str, dict[date, float]],
) -> None:
    """A machine no qualified person is ever in for (their shifts never meet
    its hours) would have no hours at all, which the solver can't plan (and
    which would hide the real problem): like a machine nobody lists, it keeps
    its own hours, with a notice saying why."""
    for name in qualified:
        if any(report.staffed_minutes.get((name, d), 0) > 0 for d in range(report.days)):
            continue
        never_in = all(
            report.uncovered.get((name, d)) is not None
            and sum(e - s for s, e in report.uncovered[(name, d)]) >= report.machine_minutes.get((name, d), 0)
            for d in range(report.days)
            if report.machine_minutes.get((name, d), 0) > 0
        )
        staffed_hours.pop(name, None)
        report.listed.discard(name)
        for key in [k for k in report.crews if k[0] == name]:
            del report.crews[key]
        people = ", ".join(o.name for o in qualified[name])
        why = "is ever in while it runs" if never_in else "is ever free while it runs (they're on other machines)"
        report.notices.append(
            f"Nobody listed for {name} ({people}) {why}, so its hours aren't checked against people. Check their shifts."
        )
