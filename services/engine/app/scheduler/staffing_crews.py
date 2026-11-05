"""People and machines on one day: who is free, crews, and taking their time."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from itertools import pairwise
from typing import TYPE_CHECKING

from app.models import Operator, WorkCenter
from app.scheduler.calendar import DAY
from app.scheduler.staffing_windows import (
    Window,
    _at_least,
    _intersect,
    _length,
    _merge,
    _shift_windows,
    _subtract,
    _truncate,
)

if TYPE_CHECKING:
    from app.scheduler.staffing import StaffingReport

# Proportional spreading converges in a few rounds; past this the remainder is
# rounding dust.
MAX_ROUNDS = 12


EPSILON = 1e-6


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


def _others_free(
    machine: _Machine, d: int, person: _Person, qualified: list[Operator], by_id: dict[str, _Person]
) -> list[Window]:
    """For a machine needing a crew: when enough other qualified people are free too."""
    if machine.crew <= 1:
        return machine.windows
    others = [w for o in qualified if o.id != person.operator.id for w in by_id[o.id].free_at(d, machine.share)]
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
    machine: _Machine,
    d: int,
    start: int,
    end: int,
    person: _Person,
    qualified: list[Operator],
    by_id: dict[str, _Person],
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
    for lo, hi in pairwise(cuts):
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
