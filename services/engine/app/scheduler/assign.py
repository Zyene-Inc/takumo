"""Named operators on jobs (F3.3 v2): who runs each operation, and when.

Staffing (staffing.py) works out, before planning, which stretches of each
machine's day are covered and by whom, on the clock: a person's minutes are
booked once, a machine at half a person takes half of someone, a machine
needing two people gets two at once. The plan then uses exactly those
minutes. This pass reads the plan back onto those stretches, so every
operation minute is run by the people staffing put there: nobody is in two
places, everyone is on shift and qualified, and planning stays as fast.

- An operation's minutes on a day are the same stretch of the machine's
  covered minutes that the plan used (its position on the machine's axis),
  so idle time in the plan stays idle.
- A lights-out machine (unattended_runs, with someone who can leave it
  running in while it runs) needs someone only for the setup, on the
  operation's first day: whoever qualified is in and free then, those who
  can leave machines running first. If nobody is, it's reported.
- Machines nobody lists, or nobody is ever in for, keep their own hours and
  get no names (staffing gives a notice).
- Clock times here are the real shift times. The plan's own start_at/end_at
  count a machine's hours from the plan's day_start, so a second-shift
  machine can differ: the assignments are the ones to read for who and when.
"""

from collections import defaultdict
from datetime import date, datetime, time, timedelta

from app.models import OperatorAssignment, ScheduledOperation, ScheduleRequest
from app.scheduler.calendar import Timeline
from app.scheduler.staffing import StaffingReport, _minute  # noqa: PLC2701

# Unassigned stretches named one by one; the rest are counted.
MAX_NOTICES = 8

Stretch = tuple[int, int, tuple[str, ...]]


def _d(day: date) -> str:
    return f"{day:%a %b} {day.day}"


def _pieces(stretches: list[Stretch], lo: int, hi: int) -> list[Stretch]:
    """Covered minutes lo..hi of the day (counted along its stretches) on the clock."""
    out: list[Stretch] = []
    seen = 0
    for start, end, crew in stretches:
        length = end - start
        a, b = max(lo, seen), min(hi, seen + length)
        if a < b:
            out.append((start + a - seen, start + b - seen, crew))
        seen += length
        if seen >= hi:
            break
    return out


class _Assigner:
    def __init__(self, request: ScheduleRequest, report: StaffingReport):
        self.request = request
        self.report = report
        self.base = datetime.combine(request.start_date, time(0, 0))
        self.names = {o.id: o.name for o in request.operators}
        self.qualified: dict[str, list] = defaultdict(list)
        for o in sorted(request.operators, key=lambda o: (not o.unattended, o.id)):
            for name in dict.fromkeys(o.work_centers):
                self.qualified[name].append(o)
        self.wcs = {wc.name: wc for wc in request.work_centers}
        self.out: list[OperatorAssignment] = []
        self.unplaced: list[tuple[ScheduledOperation, int, int]] = []

    def _at(self, minute: int) -> datetime:
        return self.base + timedelta(minutes=minute)

    def record(self, op: ScheduledOperation, who: str, start: int, end: int, setup_only: bool) -> None:
        for last in reversed(self.out[-4:]):
            if (
                last.order_no == op.order_no
                and last.seq == op.seq
                and last.operator_id == who
                and last.setup_only == setup_only
                and last.end_at == self._at(start)
            ):
                last.end_at = self._at(end)
                last.minutes += end - start
                return
        self.out.append(
            OperatorAssignment(
                order_no=op.order_no,
                seq=op.seq,
                work_center=op.work_center,
                operator_id=who,
                operator=self.names[who],
                start_at=self._at(start),
                end_at=self._at(end),
                minutes=end - start,
                setup_only=setup_only,
            )
        )

    def setup(self, op: ScheduledOperation, d: int, start: int, end: int) -> int:
        """Someone qualified, in and free sets up a lights-out machine; the
        minutes nobody could take."""
        share = min(1.0, self.wcs[op.work_center].operators_per_machine)
        left = 0
        t = start
        while t < end:
            chosen = None
            for o in self.qualified[op.work_center]:
                person = self.report.people.get(o.id)
                if person is None:
                    continue
                span = next(((s, e) for s, e in person.free_at(d, share) if s <= t < e), None)
                if span is not None:
                    chosen = (o.id, person, min(end, span[1]))
                    break
            if chosen is None:
                # Nobody free at t: try the next minute anyone frees up.
                nxt = min(
                    (
                        s
                        for o in self.qualified[op.work_center]
                        if o.id in self.report.people
                        for s, _ in self.report.people[o.id].free_at(d, share)
                        if t < s < end
                    ),
                    default=end,
                )
                left += nxt - t
                t = nxt
                continue
            who, person, stop = chosen
            person.use(d, t, stop, share)
            self.record(op, who, t, stop, setup_only=True)
            t = stop
        return left


def _setups(request: ScheduleRequest) -> dict[tuple[str, int], float]:
    part_of = {o.order_no: o.part_no for o in request.orders}
    by_part = {(p.part_no, op.seq): op.setup_min for p in request.parts for op in p.routing}
    return {
        (order_no, seq): minutes
        for order_no, part_no in part_of.items()
        for (p, seq), minutes in by_part.items()
        if p == part_no
    }


def assign_operators(
    request: ScheduleRequest,
    staffed: ScheduleRequest,
    operations: list[ScheduledOperation],
    report: StaffingReport,
) -> tuple[list[OperatorAssignment], list[str]]:
    """Who runs each operation of a plan, and stretches nobody could be found for.

    `request` is the shop with its operators; `staffed` and `report` what
    staffing.py made of it (the plan's axis positions refer to `staffed`)."""
    if not (request.operators and operations and report.crews):
        return [], []
    machines = {name for name, _ in report.crews}
    staffed_wcs = {wc.name: wc for wc in staffed.work_centers}
    hours, minutes = divmod(_minute(request.day_start), 60)
    plan_base = datetime.combine(request.start_date, time(hours, minutes))
    setups = _setups(request)
    timelines: dict[str, Timeline] = {}
    assigner = _Assigner(request, report)
    for op in sorted(operations, key=lambda o: o.start_at):
        if op.work_center not in machines:
            continue
        timeline = timelines.get(op.work_center)
        if timeline is None:
            timeline = Timeline(staffed_wcs[op.work_center], request.start_date, staffed.capacity_factor)
            timelines[op.work_center] = timeline
        start = timeline.pos_at_or_after(round((op.start_at - plan_base).total_seconds() / 60))
        end = start + op.minutes
        first = timeline.day_of(start)
        setup_left = setups.get((op.order_no, op.seq), 0.0)
        for d in range(first, timeline.day_of(end - 1) + 1):
            lo, hi = max(start, timeline.cum[d]), min(end, timeline.cum[d + 1])
            if lo >= hi:
                continue
            # The day's covered minutes this part of the operation uses.
            clock_lo = round((lo - timeline.cum[d]) / timeline.scale)
            clock_hi = round((hi - timeline.cum[d]) / timeline.scale)
            stretches = report.crews.get((op.work_center, d), [])
            pieces = _pieces(stretches, clock_lo, clock_hi)
            if (op.work_center, d) in report.lights_out:
                if d == first and setup_left > 0:
                    setup = round(setup_left / timeline.scale)
                    for s, e, _ in _pieces(pieces, 0, setup):
                        missing = assigner.setup(op, d, s, e)
                        if missing:
                            assigner.unplaced.append((op, d, missing))
                continue
            for s, e, crew in pieces:
                for who in crew:
                    assigner.record(op, who, s, e, setup_only=False)
            covered = sum(e - s for s, e, _ in pieces)
            # A minute either way is the axis' rounding, not a person short.
            if clock_hi - clock_lo - covered > 1:
                assigner.unplaced.append((op, d, clock_hi - clock_lo - covered))
    assigner.out.sort(key=lambda a: (a.start_at, a.work_center, a.operator_id))
    return assigner.out, _notices(assigner.unplaced, request.start_date)


def _notices(unplaced: list[tuple[ScheduledOperation, int, int]], start: date) -> list[str]:
    lines = [
        f"Nobody qualified is free for {minutes} min of {op.order_no} op {op.seq} on "
        f"{op.work_center} on {_d(start + timedelta(days=d))}: check who's on shift."
        for op, d, minutes in unplaced
        if minutes > 0
    ]
    if len(lines) > MAX_NOTICES:
        more = len(lines) - MAX_NOTICES
        lines = [*lines[:MAX_NOTICES], f"…and {more} more stretch{'es' if more != 1 else ''} with nobody free."]
    return lines
