"""Work-center time axes.

Every work center gets its own axis measured in *available minutes*: day i
(the calendar day start_date + i) contributes `minutes[i]` positions, and
`cum[i]` is where day i begins on the axis. Weekends, holidays and downtime
contribute nothing, so an operation placed on the axis automatically runs
across them. Efficiency and overtime scale the minutes a day provides.

Shop time ("abs" minutes) is the clock: day * 1440 + minutes after the shift
start. It is what operations on different machines are compared in.
"""

import math
from bisect import bisect_right
from datetime import date, datetime, time, timedelta

from app.models import WorkCenter

DAY = 1440
MAX_DAYS = 3 * 365  # plans never look further ahead than this


class Timeline:
    def __init__(self, work_center: WorkCenter, start: date, capacity_factor: float):
        self.work_center = work_center
        self.start = start
        # Capacity minutes per clock minute.
        self.scale = work_center.efficiency * capacity_factor
        self.scale100 = max(1, round(self.scale * 100))
        self.minutes: list[int] = []
        self.cum: list[int] = [0]

    def ensure(self, days: int) -> None:
        """Make sure the axis covers at least `days` calendar days."""
        days = min(days, MAX_DAYS)
        while len(self.minutes) < days:
            day = self.start + timedelta(days=len(self.minutes))
            hours = min(24.0, self.work_center.hours_on(day) * self.scale)
            self.minutes.append(round(hours * 60))
            self.cum.append(self.cum[-1] + self.minutes[-1])

    @property
    def days(self) -> int:
        return len(self.minutes)

    def day_of(self, pos: int) -> int:
        """The day that axis position `pos` falls in."""
        while pos >= self.cum[-1] and self.days < MAX_DAYS:
            self.ensure(self.days + 30)
        return bisect_right(self.cum, pos) - 1

    def offset(self, pos: int, day: int) -> int:
        """Clock minutes after shift start on `day` for axis position `pos`.

        Rounds up, for starts and ends alike, so back-to-back operations on a
        machine never appear to overlap by a rounding minute."""
        return math.ceil((pos - self.cum[day]) * 100 / self.scale100)

    def abs_start(self, pos: int) -> int:
        day = self.day_of(pos)
        return day * DAY + self.offset(pos, day)

    def abs_end(self, end: int) -> int:
        """Shop time when an operation ending at axis position `end` (exclusive) finishes."""
        day = self.day_of(end - 1)
        return day * DAY + self.offset(end, day)

    def pos_at_or_after(self, abs_minute: int) -> int:
        """First axis position whose shop time is at or after `abs_minute`."""
        if abs_minute <= 0:
            return 0
        day, minute = divmod(abs_minute, DAY)
        self.ensure(day + 2)
        if day >= self.days:
            return self.cum[-1]
        # Smallest offset whose rounded-up clock time is >= minute.
        pos = self.cum[day] + (0 if minute == 0 else (minute - 1) * self.scale100 // 100 + 1)
        return min(pos, self.cum[day + 1])


def to_datetime(start: date, day_start: str, abs_minute: int) -> datetime:
    hours, minutes = (int(x) for x in day_start.split(":"))
    return datetime.combine(start, time(hours, minutes)) + timedelta(minutes=abs_minute)


def day_index(start: date, target: date) -> int:
    """Calendar days from the plan start (negative when `target` is earlier)."""
    return (target - start).days
