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
  it was given ÷ operators_per_machine, never more than its own minutes.
- A machine marked `unattended_runs` is fully staffed on a day when an
  operator qualified on it who can leave machines running (`unattended`)
  works that day. Setup minutes aren't deducted from that operator (v1).
- A machine no operator lists keeps its own hours (unchecked) and gets a
  notice. No operators at all: nothing changes and there are no notices.
- `capacity_factor` scales people as it scales machines (the calendar applies
  it to the resulting hours). Overtime operators' minutes are multiplied by
  the overtime factor.
- The days covered run from the plan start to the later of HORIZON_DAYS and
  120 days after the last due or release date (capped at the calendar's
  MAX_DAYS). Days after that keep the machines' own hours.
"""

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


def _overlap(a: Window, b: Window) -> int:
    return max(0, min(a[1], b[1]) - max(a[0], b[0]))


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
    """One operator's windows, with what's left of each, across the horizon."""

    def __init__(self, operator: Operator, machines: list[str], minutes_factor: float):
        self.operator = operator
        self.machines = machines
        self.factor = minutes_factor
        self.windows: dict[int, list[list[float]]] = {}  # day → [[start, end, remaining]]

    def open_day(self, day: int, windows: list[Window]) -> None:
        self.windows[day] = [[s, e, (e - s) * self.factor] for s, e in windows]

    def live(self, day: int):
        """Windows that can reach machine windows on `day` (its own and the night before)."""
        return [w for d in (day - 1, day) for w in self.windows.get(d, []) if w[2] > EPSILON]


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
        _staff_day(d, day, wcs, machine_windows, qualified, order, weight, report, staffed_hours)

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
    machine_minutes: dict[str, float] = {}
    by_id = {p.operator.id: p for p in order}
    for name, windows in machine_windows.items():
        minutes = _length(windows)
        if minutes <= 0:
            continue
        machine_minutes[name] = minutes
        report.machine_minutes[(name, d)] = minutes
        if name not in qualified:
            continue  # unlisted: keeps its own hours
        wc = wcs[name]
        if wc.unattended_runs and any(
            o.unattended and _length([(s, e) for s, e, _ in by_id[o.id].windows.get(d, [])]) > 0
            for o in qualified[name]
        ):
            report.staffed_minutes[(name, d)] = minutes
            continue
        need[name] = minutes * wc.operators_per_machine
        # Machine windows no qualified person works at all (for explanations).
        covering = _merge(
            [
                (s, e)
                for o in qualified[name]
                for dd in (d - 1, d)
                for s, e, _ in by_id[o.id].windows.get(dd, [])
            ]
        )
        gaps = _subtract(windows, covering)
        if gaps:
            report.uncovered[(name, d)] = [(s - d * DAY, e - d * DAY) for s, e in gaps]

    given: dict[str, float] = defaultdict(float)
    for person in order:
        _spread(person, d, need, given, machine_windows, weight)

    for name in need:
        staffed = min(machine_minutes[name], given[name] / wcs[name].operators_per_machine)
        report.staffed_minutes[(name, d)] = staffed
        if staffed < machine_minutes[name] - EPSILON:
            staffed_hours[name][day] = staffed / 60


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


def _room(person: _Person, d: int, windows: list[Window], used: dict) -> float:
    """Minutes this person's live windows can still give a machine with these windows."""
    room = 0.0
    for w in person.live(d):
        reach = sum(_overlap((w[0], w[1]), m) for m in windows) * person.factor
        room += min(w[2], reach - used.get(id(w), 0.0))
    return max(0.0, room)


def _take(person: _Person, d: int, windows: list[Window], used: dict, minutes: float) -> float:
    """Consume up to `minutes` from the person's windows that reach the machine."""
    taken = 0.0
    for w in person.live(d):
        if taken >= minutes - EPSILON:
            break
        reach = sum(_overlap((w[0], w[1]), m) for m in windows) * person.factor
        take = min(w[2], reach - used.get(id(w), 0.0), minutes - taken)
        if take <= EPSILON:
            continue
        w[2] -= take
        used[id(w)] = used.get(id(w), 0.0) + take
        taken += take
    return taken


def _spread(
    person: _Person,
    d: int,
    need: dict[str, float],
    given: dict[str, float],
    machine_windows: dict[str, list[Window]],
    weight: dict[str, float],
) -> None:
    machines = [m for m in person.machines if m in need]
    if not machines:
        return
    # Per machine: how much of each window it has already used (a window can't
    # give a machine more than their overlap).
    used: dict[str, dict] = {m: {} for m in machines}
    for weighted in (True, False):
        for _ in range(MAX_ROUNDS):
            open_ = [
                m
                for m in machines
                if need[m] - given[m] > EPSILON
                and (weight.get(m, 0) > 0) == weighted
                and _room(person, d, machine_windows[m], used[m]) > EPSILON
            ]
            supply = sum(w[2] for w in person.live(d))
            if not open_ or supply <= EPSILON:
                break
            total = sum(weight.get(m, 0) for m in open_) if weighted else len(open_)
            moved = 0.0
            for m in open_:
                share = (weight.get(m, 0) if weighted else 1) / total
                want = min(supply * share, need[m] - given[m])
                got = _take(person, d, machine_windows[m], used[m], want)
                given[m] += got
                moved += got
            if moved <= EPSILON:
                break
