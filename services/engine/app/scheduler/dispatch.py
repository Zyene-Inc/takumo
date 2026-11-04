"""Dispatch-rule scheduler: fast, greedy, always returns a plan.

Pinned operations go down first, then orders in priority / due-date order,
each operation on whichever allowed machine finishes it soonest. It's used to
size the CP-SAT horizon, to warm-start CP-SAT, to find pin conflicts, and as
the plan when CP-SAT can't finish in the time limit on a very large shop.
"""

from bisect import insort
from dataclasses import dataclass, field

from app.models import Conflict, Order, Part, Pin, ScheduleRequest
from app.scheduler.calendar import DAY, Timeline, day_index


@dataclass
class Placement:
    work_center: str
    start: int  # axis position (available minutes) on that work center
    end: int  # exclusive
    pinned: bool = False


@dataclass
class DispatchResult:
    placements: dict[tuple[str, int], Placement] = field(default_factory=dict)
    conflicts: list[Conflict] = field(default_factory=list)


class _Machine:
    def __init__(self, timeline: Timeline):
        self.timeline = timeline
        self.busy: list[tuple[int, int]] = []  # sorted (start, end)

    def earliest_fit(self, earliest: int, minutes: int) -> int:
        start = earliest
        for busy_start, busy_end in self.busy:
            if busy_end <= start:
                continue
            if busy_start >= start + minutes:
                break
            start = busy_end
        self.timeline.day_of(start + minutes)  # extend the axis if needed
        return start

    def overlaps(self, start: int, end: int) -> bool:
        return any(s < end and start < e for s, e in self.busy)

    def book(self, start: int, end: int) -> None:
        insort(self.busy, (start, end))


def candidates(op, timelines: dict[str, Timeline]) -> list[str]:
    return [op.work_center] + [
        alt for alt in op.alt_work_centers if alt in timelines and alt != op.work_center
    ]


def release_minute(order: Order, start) -> int:
    """Shop minute the order's material is in (0 = from the plan start)."""
    if order.release_date is None:
        return 0
    return max(0, day_index(start, order.release_date)) * DAY


def order_sort_key(order: Order) -> tuple:
    return (-order.priority, order.due_date, order.order_no)


def dispatch(
    request: ScheduleRequest,
    timelines: dict[str, Timeline],
    parts: dict[str, Part],
    keep: dict[tuple[str, int], tuple[str, int]] | None = None,
    first: set[str] | None = None,
) -> DispatchResult:
    """`keep` maps (order, seq) → (machine, shop-time start) from an earlier plan:
    those operations stay on that machine, as close to that time as this
    request's calendar allows, before anything new is fitted around them.
    Orders in `first` are placed before the kept operations (a rush order)."""
    result = DispatchResult()
    machines = {name: _Machine(t) for name, t in timelines.items()}
    pins: dict[tuple[str, int], Pin] = {(p.order_no, p.seq): p for p in request.pins}
    orders = {o.order_no: o for o in request.orders}

    # 1. Pinned operations, in day order.
    for pin in sorted(pins.values(), key=lambda p: (p.start_date, p.order_no, p.seq)):
        order = orders[pin.order_no]
        op = next(o for o in parts[order.part_no].routing if o.seq == pin.seq)
        machine = machines[pin.work_center]
        timeline = machine.timeline
        day = day_index(request.start_date, pin.start_date)
        timeline.ensure(day + 2)
        minutes = op.duration(order.qty)
        if timeline.minutes[day] == 0:
            result.conflicts.append(
                Conflict(
                    order_no=pin.order_no,
                    seq=pin.seq,
                    message=f"{pin.work_center} isn't running on {pin.start_date}.",
                )
            )
            start = timeline.cum[day]
        else:
            start = machine.earliest_fit(timeline.cum[day], minutes)
            if start >= timeline.cum[day + 1]:
                result.conflicts.append(
                    Conflict(
                        order_no=pin.order_no,
                        seq=pin.seq,
                        message=(
                            f"{pin.work_center} is already full on {pin.start_date} "
                            "with other pinned work."
                        ),
                    )
                )
                start = timeline.cum[day]
        machine.book(start, start + minutes)
        result.placements[(pin.order_no, pin.seq)] = Placement(
            pin.work_center, start, start + minutes, pinned=True
        )

    # 2. Rush orders, ahead of everything kept from an earlier plan.
    if first:
        _place_orders(
            [o for o in request.orders if o.order_no in first],
            parts, timelines, machines, result, request.start_date,
        )

    # 3. Operations kept from an earlier plan, in time order.
    ready: dict[str, int] = {}
    for key, (name, abs_start) in sorted((keep or {}).items(), key=lambda kv: kv[1][1]):
        if key in result.placements:
            continue
        order = orders[key[0]]
        op = next(o for o in parts[order.part_no].routing if o.seq == key[1])
        machine = machines[name]
        minutes = op.duration(order.qty)
        for step in parts[order.part_no].routing:  # e.g. a pinned earlier op
            done = result.placements.get((order.order_no, step.seq))
            if done and step.seq < op.seq:
                finish = timelines[done.work_center].abs_end(done.end)
                ready[order.order_no] = max(ready.get(order.order_no, 0), finish)
        released = release_minute(order, request.start_date)
        earliest = machine.timeline.pos_at_or_after(
            max(abs_start, ready.get(order.order_no, released))
        )
        start = machine.earliest_fit(earliest, minutes)
        machine.book(start, start + minutes)
        result.placements[key] = Placement(name, start, start + minutes)
        ready[order.order_no] = machine.timeline.abs_end(start + minutes)

    # 4. Everything else, most urgent order first.
    _place_orders(
        [o for o in request.orders if not first or o.order_no not in first],
        parts, timelines, machines, result, request.start_date,
    )
    return result


def _place_orders(
    selected: list[Order],
    parts: dict[str, Part],
    timelines: dict[str, Timeline],
    machines: dict[str, "_Machine"],
    result: DispatchResult,
    plan_start,
) -> None:
    for order in sorted(selected, key=order_sort_key):
        # Shop minute the previous operation finishes (or the material arrives).
        ready = release_minute(order, plan_start)
        previous_seq: int | None = None
        for op in sorted(parts[order.part_no].routing, key=lambda o: o.seq):
            key = (order.order_no, op.seq)
            minutes = op.duration(order.qty)
            placed = result.placements.get(key)
            if placed:
                timeline = timelines[placed.work_center]
                if timeline.abs_start(placed.start) < ready and previous_seq is not None:
                    result.conflicts.append(
                        Conflict(
                            order_no=order.order_no,
                            seq=op.seq,
                            message=(
                                f"Op {op.seq} is pinned to start before op {previous_seq} "
                                "can finish."
                            ),
                        )
                    )
                ready = max(ready, timeline.abs_end(placed.end))
                previous_seq = op.seq
                continue

            best: Placement | None = None
            best_end = 0
            for name in candidates(op, timelines):
                machine = machines[name]
                start = machine.earliest_fit(machine.timeline.pos_at_or_after(ready), minutes)
                end_abs = machine.timeline.abs_end(start + minutes)
                if best is None or end_abs < best_end:
                    best, best_end = Placement(name, start, start + minutes), end_abs
            assert best is not None
            machines[best.work_center].book(best.start, best.end)
            result.placements[key] = best
            ready = best_end
            previous_seq = op.seq

