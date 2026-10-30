"""Working-day calendar: Monday–Friday, no holidays yet.

Day index 0 is the first working day on or after the start date.
Holidays and per-machine downtime come later from CalendarDay rows.
"""

from datetime import date, timedelta


def _is_working_day(d: date) -> bool:
    return d.weekday() < 5


def first_working_day(start: date) -> date:
    d = start
    while not _is_working_day(d):
        d += timedelta(days=1)
    return d


def day_index_to_date(start: date, index: int) -> date:
    d = first_working_day(start)
    remaining = index
    while remaining > 0:
        d += timedelta(days=1)
        if _is_working_day(d):
            remaining -= 1
    return d


def date_to_day_index(start: date, target: date) -> int:
    """Last working-day index on or before `target` (negative if before start)."""
    d = first_working_day(start)
    if target < d:
        return -1
    index = 0
    while True:
        nxt = d + timedelta(days=1)
        while not _is_working_day(nxt):
            nxt += timedelta(days=1)
        if nxt > target:
            return index
        d = nxt
        index += 1
