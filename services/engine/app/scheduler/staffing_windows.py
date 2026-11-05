"""Shift windows on the clock: building, merging, intersecting and trimming them."""

from collections import defaultdict
from datetime import date
from functools import lru_cache

from app.models import ScheduleRequest, ShiftWindow, WorkCenter
from app.scheduler.calendar import DAY, MAX_DAYS

HORIZON_DAYS = 400


Window = tuple[int, int]  # clock minutes from the plan start's midnight, end exclusive


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


def _machine_windows(wc: WorkCenter, day: date, offset: int, day_start: int) -> list[Window]:
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
        [(d - request.start_date).days for o in request.orders for d in (o.due_date, o.release_date) if d is not None],
        default=0,
    )
    return min(MAX_DAYS, max(HORIZON_DAYS, latest + 120))


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
