"""Independent checks that a plan is physically possible.

Re-derives everything from the request, not from the solver's internals:
machines never run two operations at once, operations follow routing order
in clock time, start no earlier than the material arrives, run on an allowed
machine, fit the machine's working hours, and pinned operations stay where
they were pinned.
"""

from collections import defaultdict
from datetime import datetime, timedelta

from app.models import ScheduleRequest, ScheduleResponse


def assert_valid_plan(request: ScheduleRequest, response: ScheduleResponse) -> None:
    assert response.status in ("OPTIMAL", "FEASIBLE", "HEURISTIC"), response.status
    parts = {p.part_no: p for p in request.parts}
    wcs = {wc.name: wc for wc in request.work_centers}
    pins = {(p.order_no, p.seq): p for p in request.pins}
    ops = {(op.order_no, op.seq): op for op in response.operations}

    # Every operation of every order is planned exactly once.
    expected = {
        (o.order_no, r.seq) for o in request.orders for r in parts[o.part_no].routing
    }
    assert set(ops) == expected
    assert len(ops) == len(response.operations)

    by_machine = defaultdict(list)
    for order in request.orders:
        routing = sorted(parts[order.part_no].routing, key=lambda r: r.seq)
        previous_end: datetime | None = None
        if order.release_date:
            first = ops[(order.order_no, routing[0].seq)]
            assert first.start_date >= order.release_date, order.order_no
        for step in routing:
            op = ops[(order.order_no, step.seq)]
            assert op.work_center in [step.work_center, *step.alt_work_centers]
            assert op.minutes == step.duration(order.qty)
            assert op.start_at < op.end_at
            assert op.start_date >= request.start_date
            assert wcs[op.work_center].hours_on(op.start_date) > 0
            assert wcs[op.work_center].hours_on(op.end_date) > 0
            if previous_end is not None:
                assert op.start_at >= previous_end, (order.order_no, step.seq)
            previous_end = op.end_at
            by_machine[op.work_center].append(op)
            pin = pins.get((order.order_no, step.seq))
            if pin:
                assert op.pinned
                assert op.work_center == pin.work_center
                assert op.start_date == pin.start_date

    for machine_ops in by_machine.values():
        machine_ops.sort(key=lambda op: op.start_at)
        for a, b in zip(machine_ops, machine_ops[1:]):
            assert a.end_at <= b.start_at, (a, b)

    # Daily load never exceeds what the machine has that day.
    for day in response.load:
        assert day.load_minutes <= day.capacity_minutes, day

    # Load adds up to the work planned.
    planned = defaultdict(int)
    for op in response.operations:
        planned[op.work_center] += op.minutes
    loaded = defaultdict(int)
    for day in response.load:
        loaded[day.work_center] += day.load_minutes
    assert dict(planned) == {k: v for k, v in loaded.items() if v}

    for result in response.orders:
        order = next(o for o in request.orders if o.order_no == result.order_no)
        last = max(
            (op for op in response.operations if op.order_no == order.order_no),
            key=lambda op: op.end_at,
        )
        assert result.completion_date == last.end_date
        assert result.days_late == max(0, (last.end_date - order.due_date).days)


def working_days(start, n):
    """The first n weekdays from start (for building pins)."""
    days, d = [], start
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return days


def assert_staffed_plan(request: ScheduleRequest, response: ScheduleResponse) -> None:
    """With a roster: no machine works more than its people cover (F3.3-R7).

    Re-derived from the roster, not from staffing.py: a machine some operator
    lists, on a day none of them works at all, carries no load; and a
    machine-day never carries more than its own hours or its staffed hours.
    """
    from datetime import timedelta

    assert_valid_plan(request, response)
    listed = {name for o in request.operators for name in o.work_centers}
    wcs = {wc.name: wc for wc in request.work_centers}

    def works(operator, day) -> bool:
        off = next((t for t in operator.time_off if t.date == day), None)
        if off is not None and off.hours == 0:
            return False
        if not operator.shifts:
            return True
        # A shift starting the day before can run past midnight into this day.
        return any(
            d.weekday() in shift.days
            for shift in operator.shifts
            for d in (day, day - timedelta(days=1))
            if d == day or shift.end <= shift.start
        )

    for load in response.load:
        assert load.machine_minutes is not None
        assert load.capacity_minutes <= load.machine_minutes, load
        assert load.load_minutes <= load.capacity_minutes, load
        if load.work_center not in listed:
            continue
        people = [o for o in request.operators if load.work_center in o.work_centers]
        if wcs[load.work_center].unattended_runs and any(
            o.unattended and works(o, load.date) for o in people
        ):
            continue
        if not any(works(o, load.date) for o in people):
            assert load.load_minutes == 0, load
            assert load.capacity_minutes == 0, load
