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

import math
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from datetime import date, timedelta

from app.models import DayException, Operator, ScheduleRequest, ShiftWindow, WorkCenter
from app.scheduler.calendar import DAY, MAX_DAYS

HORIZON_DAYS = 400
# Proportional spreading converges in a few rounds; past this the remainder is
# rounding dust.
MAX_ROUNDS = 12
EPSILON = 1e-6

Window = tuple[int, int]  # clock minutes from the plan start's midnight, end exclusive


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


@lru_cache(maxsize=4096)
def _minute(clock: str) -> int:
    hours, minutes = (int(x) for x in clock.split(":"))
    return hours * 60 + minutes


@lru_cache(maxsize=4096)
def _weekday_windows(shifts: tuple[tuple[tuple[int, ...], str, str], ...], weekday: int) -> tuple[Window, ...]:
    """The shifts starting on a weekday, as minutes from that day's midnight
    (the same every week, so worked out once)."""
    windows = []
    for days, start_clock, end_clock in shifts:
        if weekday not in days:
            continue
        start, end = _minute(start_clock), _minute(end_clock)
        if end <= start:
            end += DAY
        windows.append((start, end))
    return tuple(sorted(windows))


def _shift_windows(shifts: list[ShiftWindow], day: date, offset: int) -> list[Window]:
    """The shifts that start on `day`, as absolute windows (`offset` = that day's midnight)."""
    key = tuple((tuple(s.days), s.start, s.end) for s in shifts)
    return [(offset + s, offset + e) for s, e in _weekday_windows(key, day.weekday())]


def _merge(windows: list[Window]) -> list[Window]:
    merged: list[Window] = []
    for start, end in sorted(windows):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        elif end > start:
            merged.append((start, end))
    return merged


def _length(windows: list[Window]) -> int:
    return sum(end - start for start, end in windows)


def _truncate(windows: list[Window], minutes: float) -> list[Window]:
    """The first `minutes` of the windows, in time order."""
    out: list[Window] = []
    left = minutes
    for start, end in sorted(windows):
        if left <= 0:
            break
        take = min(end - start, left)
        out.append((start, start + round(take)))
        left -= take
    return out


def _machine_windows(
    wc: WorkCenter, day: date, offset: int, day_start: int
) -> list[Window]:
    hours = wc.hours_on(day)
    if hours <= 0:
        return []
    exceptional = day in wc._exceptions_by_day()  # noqa: SLF001
    if wc.shifts and not exceptional:
        windows = _merge(_shift_windows(wc.shifts, day, offset))
        if not windows:
            return []
        # Exactly the engine's own capacity for the day: cut when the shifts
        # are longer, and when they're shorter (overtime) stay later.
        short = round(hours * 60) - _length(windows)
        if short > 0:
            start, end = windows[-1]
            windows[-1] = (start, end + short)
            return windows
        return _truncate(windows, hours * 60)
    start = offset + day_start
    return [(start, start + round(hours * 60))]


def _weights(request: ScheduleRequest) -> dict[str, float]:
    parts = {p.part_no: p for p in request.parts}
    weight: dict[str, float] = defaultdict(float)
    for order in request.orders:
        part = parts.get(order.part_no)
        if part is None:
            continue
        for op in part.routing:
            minutes = op.duration(order.qty)
            weight[op.work_center] += minutes
            share = minutes / (1 + len(op.alt_work_centers))
            for alt in op.alt_work_centers:
                weight[alt] += share
    return weight


def _horizon(request: ScheduleRequest) -> int:
    latest = max(
        [
            (d - request.start_date).days
            for o in request.orders
            for d in (o.due_date, o.release_date)
            if d is not None
        ],
        default=0,
    )
    return min(MAX_DAYS, max(HORIZON_DAYS, latest + 120))


class _Person:
    """One operator's time across the horizon: their windows on the clock and,
    minute by minute, how much of them is still free (1 = all of them; a
    machine at half a person takes 0.5)."""

    def __init__(self, operator: Operator, machines: list[str], minutes_factor: float):
        self.operator = operator
        self.machines = machines
        self.factor = minutes_factor
        self.windows: dict[int, list[Window]] = {}
        self.spans: dict[int, list[list[float]]] = {}  # day → [[start, end, free share]]

    def open_day(self, day: int, windows: list[Window]) -> None:
        # Overtime: the last window of the day runs longer, like a machine's.
        extra = round(_length(windows) * (self.factor - 1)) if windows else 0
        if extra > 0:
            last_start, last_end = windows[-1]
            windows = [*windows[:-1], (last_start, last_end + extra)]
        self.windows[day] = windows
        self.spans[day] = [[s, e, 1.0] for s, e in windows]

    def live(self, day: int):
        """Spans that can reach machine windows on `day` (its own and the night before)."""
        return [w for d in (day - 1, day) for w in self.spans.get(d, []) if w[2] > EPSILON]

    def free_minutes(self, day: int) -> float:
        return sum((e - s) * f for s, e, f in self.live(day))

    def free_at(self, day: int, share: float) -> list[Window]:
        """When at least `share` of them is free."""
        return _merge([(int(s), int(e)) for s, e, f in self.live(day) if f >= share - EPSILON])

    def use(self, day: int, start: int, end: int, share: float) -> None:
        """Book `share` of them from start to end."""
        for d in (day - 1, day):
            spans = self.spans.get(d)
            if not spans:
                continue
            out: list[list[float]] = []
            for s, e, f in spans:
                lo, hi = max(s, start), min(e, end)
                if lo >= hi:
                    out.append([s, e, f])
                    continue
                if s < lo:
                    out.append([s, lo, f])
                out.append([lo, hi, f - share])
                if hi < e:
                    out.append([hi, e, f])
            self.spans[d] = out


@dataclass
class _Machine:
    """One machine on one day: its windows and who covers which stretch."""

    name: str
    windows: list[Window]
    crew: int  # people needed at once
    share: float  # of each of them
    stretches: list[tuple[int, int, tuple[str, ...]]] = field(default_factory=list)

    def open(self) -> list[Window]:
        return _subtract(self.windows, _merge([(s, e) for s, e, _ in self.stretches]))

    def staffed(self) -> int:
        return sum(e - s for s, e, _ in self.stretches)


def _intersect(a: list[Window], b: list[Window]) -> list[Window]:
    """Both lists sorted and merged."""
    out: list[Window] = []
    i = j = 0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if lo < hi:
            out.append((lo, hi))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


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
            report.notices.append(
                f"No operator is listed for {wc.name}, so its hours aren't checked against people."
            )

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
    order = sorted(
        people, key=lambda p: (p.operator.id in last, len(p.machines), p.operator.id)
    )
    staffed_hours: dict[str, dict[date, float]] = defaultdict(dict)
    # Most days are like an earlier one (the same weekday shifts, the same
    # night before): their outcome is worked out once and moved to the date.
    seen: dict[tuple, dict] = {}

    for d in range(-1, days):
        day = request.start_date + timedelta(days=d)
        offset = d * DAY
        machine_windows = {
            name: _machine_windows(wc, day, offset, day_start) for name, wc in wcs.items()
        }
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
        added = [
            DayException(date=day, hours=hours, reason="staffing")
            for day, hours in sorted(cut.items())
        ]
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
                tuple(
                    (s - offset, e - offset, round(f, 6))
                    for dd in (d - 1, d)
                    for s, e, f in p.spans.get(dd, [])
                ),
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
    for person, spans in zip(order, known["spans"]):
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


def _operator_windows(
    person: _Person, day: date, offset: int, machine_windows: dict[str, list[Window]]
) -> list[Window]:
    operator = person.operator
    if operator.shifts:
        windows = _merge(_shift_windows(operator.shifts, day, offset))
    else:
        # "Any time": whenever one of their machines runs that day.
        windows = _merge([w for name in person.machines for w in machine_windows.get(name, [])])
    off = next((t for t in operator.time_off if t.date == day), None)
    if off is not None:
        windows = _truncate(windows, off.hours * 60) if off.hours > 0 else []
    return windows


def _staff_day(
    d: int,
    day: date,
    wcs: dict[str, WorkCenter],
    machine_windows: dict[str, list[Window]],
    qualified: dict[str, list[Operator]],
    order: list[_Person],
    weight: dict[str, float],
    report: StaffingReport,
    staffed_hours: dict[str, dict[date, float]],
) -> None:
    need: dict[str, float] = {}
    machines: dict[str, _Machine] = {}
    by_id = {p.operator.id: p for p in order}
    for name, windows in machine_windows.items():
        minutes = _length(windows)
        if minutes <= 0:
            continue
        report.machine_minutes[(name, d)] = minutes
        if name not in qualified:
            continue  # unlisted: keeps its own hours
        wc = wcs[name]
        present = [w for o in qualified[name] for dd in (d - 1, d) for w in by_id[o.id].windows.get(dd, [])]
        if wc.unattended_runs and any(
            o.unattended
            and _intersect(_merge(by_id[o.id].windows.get(d - 1, []) + by_id[o.id].windows.get(d, [])), windows)
            for o in qualified[name]
        ):
            # Lights-out: someone who can leave it running is in while it
            # runs, so it runs all its hours (they set it up; assign.py).
            report.staffed_minutes[(name, d)] = minutes
            report.crews[(name, d)] = [(s, e, ()) for s, e in windows]
            report.lights_out.add((name, d))
            continue
        crew = max(1, math.ceil(wc.operators_per_machine - EPSILON))
        machines[name] = _Machine(name, windows, crew, wc.operators_per_machine / crew)
        need[name] = minutes * wc.operators_per_machine
        # Machine windows no qualified person works at all (for explanations).
        gaps = _subtract(windows, _merge(present))
        if gaps:
            report.uncovered[(name, d)] = [(s - d * DAY, e - d * DAY) for s, e in gaps]

    given: dict[str, float] = defaultdict(float)
    for person in order:
        _spread(person, d, machines, need, given, weight, qualified, by_id)

    for name, machine in machines.items():
        stretches = sorted(machine.stretches)
        report.crews[(name, d)] = stretches
        staffed = machine.staffed()
        report.staffed_minutes[(name, d)] = staffed
        if staffed < report.machine_minutes[(name, d)] - EPSILON:
            staffed_hours[name][day] = staffed / 60


def _at_least(windows: list[Window], count: int) -> list[Window]:
    """When at least `count` of these (people's) windows are open at once."""
    if count <= 1:
        return _merge(windows)
    events = sorted([(s, 1) for s, _ in windows] + [(e, -1) for _, e in windows])
    out: list[Window] = []
    open_, since = 0, 0
    for t, delta in events:
        before = open_
        open_ += delta
        if before < count <= open_:
            since = t
        elif open_ < count <= before and t > since:
            out.append((since, t))
    return _merge(out)


def _subtract(windows: list[Window], covering: list[Window]) -> list[Window]:
    gaps: list[Window] = []
    for start, end in windows:
        cursor = start
        for c_start, c_end in covering:
            if c_end <= cursor or c_start >= end:
                continue
            if c_start > cursor:
                gaps.append((cursor, c_start))
            cursor = max(cursor, c_end)
        if cursor < end:
            gaps.append((cursor, end))
    return gaps


def _others_free(
    machine: _Machine, d: int, person: _Person, qualified: list[Operator], by_id: dict[str, _Person]
) -> list[Window]:
    """For a machine needing a crew: when enough other qualified people are free too."""
    if machine.crew <= 1:
        return machine.windows
    others = [
        w
        for o in qualified
        if o.id != person.operator.id
        for w in by_id[o.id].free_at(d, machine.share)
    ]
    return _at_least(others, machine.crew - 1)


def _available(
    person: _Person, d: int, machine: _Machine, qualified: list[Operator], by_id: dict[str, _Person]
) -> list[Window]:
    """When this person could run the machine now: they're free, it's running
    and not yet covered, and (for a crew) enough others are free too."""
    times = _intersect(person.free_at(d, machine.share), machine.open())
    if machine.crew > 1 and times:
        times = _intersect(times, _others_free(machine, d, person, qualified, by_id))
    return times


def _crew_for(
    machine: _Machine, d: int, start: int, end: int, person: _Person, qualified: list[Operator], by_id: dict[str, _Person]
) -> list[tuple[int, int, list[_Person]]]:
    """Who joins this person on the machine from start to end, piece by piece
    (the free people can change partway): fewest machines first."""
    if machine.crew <= 1:
        return [(start, end, [person])]
    others = [by_id[o.id] for o in qualified if o.id != person.operator.id]
    cuts = sorted(
        {start, end}
        | {int(x) for p in others for s, e in p.free_at(d, machine.share) for x in (s, e) if start < x < end}
    )
    pieces = []
    for lo, hi in zip(cuts, cuts[1:]):
        free = sorted(
            (p for p in others if any(s <= lo and hi <= e for s, e in p.free_at(d, machine.share))),
            key=lambda p: (len(p.machines), p.operator.id),
        )
        if len(free) >= machine.crew - 1:
            pieces.append((lo, hi, [person, *free[: machine.crew - 1]]))
    return pieces


def _take(
    person: _Person,
    d: int,
    machine: _Machine,
    want: float,
    qualified: list[Operator],
    by_id: dict[str, _Person],
) -> float:
    """Cover up to `want` of this person's minutes on the machine, earliest
    first; returns everyone's minutes used (a crew's included)."""
    minutes = want / machine.share  # machine minutes
    used = 0.0
    for start, end in _available(person, d, machine, qualified, by_id):
        if minutes <= EPSILON:
            break
        stop = start + min(end - start, math.ceil(minutes - EPSILON))
        for lo, hi, crew in _crew_for(machine, d, start, stop, person, qualified, by_id):
            for p in crew:
                p.use(d, lo, hi, machine.share)
            machine.stretches.append((lo, hi, tuple(p.operator.id for p in crew)))
            used += (hi - lo) * machine.share * len(crew)
            minutes -= hi - lo
    return used


def _spread(
    person: _Person,
    d: int,
    machines: dict[str, _Machine],
    need: dict[str, float],
    given: dict[str, float],
    weight: dict[str, float],
    qualified: dict[str, list[Operator]],
    by_id: dict[str, _Person],
) -> None:
    mine = [m for m in person.machines if m in need]
    if not mine:
        return
    for weighted in (True, False):
        for _ in range(MAX_ROUNDS):
            reach = {
                m: _available(person, d, machines[m], qualified[m], by_id)
                for m in mine
                if need[m] - given[m] > EPSILON and (weight.get(m, 0) > 0) == weighted
            }
            room = {m: _length(times) * machines[m].share for m, times in reach.items()}
            open_ = [m for m, r in room.items() if r > EPSILON]
            # Only the minutes their machines can use are shared out (a night
            # shift's hours after every machine stops aren't).
            usable = _length(_merge([w for m in open_ for w in reach[m]]))
            supply = min(person.free_minutes(d), usable)
            if not open_ or supply <= EPSILON:
                break
            total = sum(weight.get(m, 0) for m in open_) if weighted else len(open_)
            moved = 0.0
            for m in open_:
                share = (weight.get(m, 0) if weighted else 1) / total
                want = min(supply * share, need[m] - given[m], room[m])
                got = _take(person, d, machines[m], want, qualified[m], by_id)
                given[m] += got
                moved += got
            if moved <= EPSILON:
                break
