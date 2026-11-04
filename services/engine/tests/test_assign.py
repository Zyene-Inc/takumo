"""Phase 3 v2: named operators on jobs (assign.py)."""

import random
import time
from collections import defaultdict
from datetime import date, datetime, timedelta

from app.models import (
    DayException,
    Operation,
    Operator,
    Order,
    Part,
    ScheduleRequest,
    ScheduleResponse,
    ShiftWindow,
    WorkCenter,
)
from app.scheduler.cpsat_model import solve_schedule
from tests.test_scheduler import random_shop
from tests.test_staffing import DAY_SHIFT, SECOND_SHIFT, START, random_roster, with_releases

DUE = START + timedelta(days=10)


def _shop(operators: list[Operator], *work_centers: WorkCenter, orders: list[Order]) -> ScheduleRequest:
    names = [wc.name for wc in work_centers]
    return ScheduleRequest(
        start_date=START,
        work_centers=list(work_centers),
        parts=[
            Part(part_no=f"P-{n}", routing=[Operation(seq=10, work_center=n, setup_min=60, run_min_per_unit=60)])
            for n in names
        ],
        orders=orders,
        operators=operators,
        time_limit_s=3,
    )


def _order(no: str, machine: str, qty: int, **kw) -> Order:
    return Order(order_no=no, part_no=f"P-{machine}", qty=qty, due_date=DUE, **kw)


def _at(day: int, clock: str) -> datetime:
    h, m = (int(x) for x in clock.split(":"))
    return datetime.combine(START + timedelta(days=day), datetime.min.time()) + timedelta(hours=h, minutes=m)


def _windows(operator: Operator, day: date) -> list[tuple[datetime, datetime]]:
    """An operator's shifts starting on `day` (independent of assign.py)."""
    if any(t.date == day and t.hours == 0 for t in operator.time_off):
        return []
    out = []
    for s in operator.shifts:
        if day.weekday() not in s.days:
            continue
        start = datetime.combine(day, datetime.min.time()) + timedelta(
            hours=int(s.start[:2]), minutes=int(s.start[3:])
        )
        end = datetime.combine(day, datetime.min.time()) + timedelta(hours=int(s.end[:2]), minutes=int(s.end[3:]))
        if end <= start:
            end += timedelta(days=1)
        out.append((start, end))
    return out


def assert_assignments_valid(request: ScheduleRequest, response: ScheduleResponse) -> None:
    """Who runs what: qualified, on shift, never more than one person's worth
    at once, one operation at a time per machine, and no more than the plan."""
    people = {o.id: o for o in request.operators}
    wcs = {wc.name: wc for wc in request.work_centers}
    load: dict[str, list[tuple[datetime, float]]] = defaultdict(list)
    per_machine: dict[str, list[tuple[datetime, datetime, str]]] = defaultdict(list)
    for a in response.assignments:
        person = people[a.operator_id]
        wc = wcs[a.work_center]
        assert a.work_center in person.work_centers, a
        assert a.end_at > a.start_at
        assert a.minutes == round((a.end_at - a.start_at).total_seconds() / 60)
        if person.shifts:
            day = a.start_at.date()
            shifts = _windows(person, day) + _windows(person, day - timedelta(days=1))
            assert any(s <= a.start_at and a.end_at <= e for s, e in shifts), (a, shifts)
        else:
            assert not any(t.date == a.start_at.date() and t.hours == 0 for t in person.time_off), a
        crew = max(1, -(-wc.operators_per_machine // 1))
        share = wc.operators_per_machine / crew
        load[a.operator_id] += [(a.start_at, share), (a.end_at, -share)]
        per_machine[a.work_center].append((a.start_at, a.end_at, f"{a.order_no}/{a.seq}"))
    for operator, events in load.items():
        running = 0.0
        for _, delta in sorted(events, key=lambda e: (e[0], e[1])):
            running += delta
            assert running <= 1 + 1e-6, (operator, running)
    for machine, spans in per_machine.items():
        spans.sort()
        for (s1, e1, op1), (s2, _, op2) in zip(spans, spans[1:]):
            assert s2 >= e1 or op1 == op2, (machine, op1, op2)
    by_op: dict[tuple[str, int], int] = defaultdict(int)
    crews = {wc.name: max(1, -(-wc.operators_per_machine // 1)) for wc in request.work_centers}
    for a in response.assignments:
        by_op[(a.order_no, a.seq)] += a.minutes / crews[a.work_center]
    for op in response.operations:
        scale = wcs[op.work_center].efficiency * request.capacity_factor
        days = (op.end_date - op.start_date).days + 1
        assert by_op.get((op.order_no, op.seq), 0) <= op.minutes / scale + days + 1e-6, op


def test_one_person_runs_the_job_on_their_shift():
    sam = Operator(id="sam", name="Sam", work_centers=["VF2"], shifts=[DAY_SHIFT])
    request = _shop([sam], WorkCenter(name="VF2", hours_per_day=8, shifts=[DAY_SHIFT]), orders=[_order("O1", "VF2", 3)])
    response = solve_schedule(request, assign=True)
    assert_assignments_valid(request, response)
    [a] = response.assignments
    [op] = response.operations
    # 60 setup + 3 × 60 run = 4 h, when the plan runs it (a day-shift
    # machine's plan times are its clock times).
    assert (a.operator, a.start_at, a.end_at, a.minutes) == ("Sam", op.start_at, op.end_at, 240)
    assert response.notices == []


def test_a_long_job_hands_over_from_day_to_second_shift():
    sam = Operator(id="sam", name="Sam", work_centers=["VF2"], shifts=[DAY_SHIFT])
    ana = Operator(id="ana", name="Ana", work_centers=["VF2"], shifts=[SECOND_SHIFT])
    vf2 = WorkCenter(name="VF2", hours_per_day=16, shifts=[DAY_SHIFT, SECOND_SHIFT])
    # 60 + 11 × 60 = 12 h: Sam 07:00–15:00, Ana 15:00–19:00.
    request = _shop([sam, ana], vf2, orders=[_order("O1", "VF2", 11)])
    response = solve_schedule(request, assign=True)
    assert_assignments_valid(request, response)
    sam, ana = response.assignments
    # 12 h on a 16 h day always spans the 15:00 handover.
    assert (sam.operator, sam.end_at, ana.operator, ana.start_at) == ("Sam", _at(0, "15:00"), "Ana", _at(0, "15:00"))
    assert sam.minutes + ana.minutes == 720
    [op] = response.operations
    assert (sam.start_at, ana.end_at) == (op.start_at, op.end_at)


def test_a_second_shift_machine_is_run_at_second_shift_times():
    ana = Operator(id="ana", name="Ana", work_centers=["VF2"], shifts=[SECOND_SHIFT])
    vf2 = WorkCenter(name="VF2", hours_per_day=8, shifts=[SECOND_SHIFT])
    request = _shop([ana], vf2, orders=[_order("O1", "VF2", 1)])
    response = solve_schedule(request, assign=True)
    assert_assignments_valid(request, response)
    [a] = response.assignments
    # On the clock, inside the second shift (the plan's own times count from
    # 07:00; the assignment is when it really runs).
    assert _at(0, "15:00") <= a.start_at and a.end_at <= _at(0, "23:00")
    assert (a.operator, a.minutes) == ("Ana", 120)


def test_half_a_person_per_machine_lets_one_person_run_two():
    sam = Operator(id="sam", name="Sam", work_centers=["A", "B"], shifts=[DAY_SHIFT])
    machines = [WorkCenter(name=n, hours_per_day=8, shifts=[DAY_SHIFT], operators_per_machine=0.5) for n in "AB"]
    request = _shop([sam], *machines, orders=[_order("OA", "A", 7), _order("OB", "B", 7)])
    response = solve_schedule(request, assign=True)
    assert_assignments_valid(request, response)
    spans = {(a.work_center, a.start_at, a.end_at) for a in response.assignments}
    assert spans == {("A", _at(0, "07:00"), _at(0, "15:00")), ("B", _at(0, "07:00"), _at(0, "15:00"))}


def test_a_full_person_per_machine_is_never_in_two_places():
    sam = Operator(id="sam", name="Sam", work_centers=["A", "B"], shifts=[DAY_SHIFT])
    machines = [WorkCenter(name=n, hours_per_day=8, shifts=[DAY_SHIFT]) for n in "AB"]
    request = _shop([sam], *machines, orders=[_order("OA", "A", 3), _order("OB", "B", 3)])
    response = solve_schedule(request, assign=True)
    assert_assignments_valid(request, response)
    assert sum(a.minutes for a in response.assignments) == 480


def test_a_machine_that_needs_two_people_gets_a_crew():
    sam = Operator(id="sam", name="Sam", work_centers=["PRESS"], shifts=[DAY_SHIFT])
    ana = Operator(id="ana", name="Ana", work_centers=["PRESS"], shifts=[DAY_SHIFT])
    press = WorkCenter(name="PRESS", hours_per_day=8, shifts=[DAY_SHIFT], operators_per_machine=2)
    request = _shop([sam, ana], press, orders=[_order("O1", "PRESS", 1)])
    response = solve_schedule(request, assign=True)
    assert_assignments_valid(request, response)
    assert sorted(a.operator for a in response.assignments) == ["Ana", "Sam"]
    [op] = response.operations
    assert {(a.start_at, a.end_at, a.minutes) for a in response.assignments} == {(op.start_at, op.end_at, 120)}


def test_lights_out_needs_someone_only_for_the_setup():
    sam = Operator(id="sam", name="Sam", work_centers=["VF2"], shifts=[DAY_SHIFT], unattended=True)
    vf2 = WorkCenter(name="VF2", hours_per_day=16, shifts=[DAY_SHIFT, SECOND_SHIFT], unattended_runs=True)
    request = _shop([sam], vf2, orders=[_order("O1", "VF2", 10)])
    response = solve_schedule(request, assign=True)
    [a] = response.assignments
    assert (a.operator, a.setup_only, a.minutes) == ("Sam", True, 60)


def test_nobody_is_assigned_on_their_day_off():
    off = DayException(date=START, hours=0, reason="vacation")
    sam = Operator(id="sam", name="Sam", work_centers=["VF2"], shifts=[DAY_SHIFT], time_off=[off])
    ana = Operator(id="ana", name="Ana", work_centers=["VF2"], shifts=[DAY_SHIFT])
    request = _shop([sam, ana], WorkCenter(name="VF2", hours_per_day=8, shifts=[DAY_SHIFT]), orders=[_order("O1", "VF2", 10)])
    response = solve_schedule(request, assign=True)
    assert_assignments_valid(request, response)
    assert {a.operator for a in response.assignments if a.start_at.date() == START} == {"Ana"}


def test_machines_nobody_lists_get_no_names():
    sam = Operator(id="sam", name="Sam", work_centers=["VF2"], shifts=[DAY_SHIFT])
    request = _shop(
        [sam],
        WorkCenter(name="VF2", hours_per_day=8, shifts=[DAY_SHIFT]),
        WorkCenter(name="SAW", hours_per_day=8),
        orders=[_order("O1", "VF2", 1), _order("O2", "SAW", 1)],
    )
    response = solve_schedule(request, assign=True)
    assert {a.work_center for a in response.assignments} == {"VF2"}


def test_without_operators_or_without_asking_there_are_no_assignments():
    request = _shop([], WorkCenter(name="VF2", hours_per_day=8), orders=[_order("O1", "VF2", 1)])
    assert solve_schedule(request, assign=True).assignments == []
    sam = Operator(id="sam", name="Sam", work_centers=["VF2"], shifts=[DAY_SHIFT])
    request = _shop([sam], WorkCenter(name="VF2", hours_per_day=8, shifts=[DAY_SHIFT]), orders=[_order("O1", "VF2", 1)])
    assert solve_schedule(request).assignments == []


def test_random_shops_assign_people_validly():
    rng = random.Random(41)
    for _ in range(10):
        request = with_releases(rng, random_shop(rng, orders=rng.randint(5, 15)))
        for wc in request.work_centers:
            wc.unattended_runs = rng.random() < 0.2
            wc.operators_per_machine = rng.choice([0.5, 1, 1, 1, 2])
        request.operators = random_roster(rng, request)
        request.time_limit_s = 2
        response = solve_schedule(request, assign=True)
        assert_assignments_valid(request, response)


def test_assigning_a_big_shop_is_quick():
    """50 machines, 300 jobs, 40 people: naming them adds well under the
    solver's own time."""
    rng = random.Random(3)
    names = [f"M{i:02d}" for i in range(50)]
    work_centers = [WorkCenter(name=n, hours_per_day=16, shifts=[DAY_SHIFT, SECOND_SHIFT]) for n in names]
    parts = [
        Part(
            part_no=f"P{p}",
            routing=[
                Operation(
                    seq=(s + 1) * 10,
                    work_center=rng.choice(names),
                    setup_min=rng.randint(15, 60),
                    run_min_per_unit=rng.choice([0.5, 1, 2, 4]),
                )
                for s in range(rng.randint(2, 4))
            ],
        )
        for p in range(40)
    ]
    orders = [
        Order(
            order_no=f"O{i}",
            part_no=rng.choice(parts).part_no,
            qty=rng.randint(10, 120),
            due_date=START + timedelta(days=rng.randint(3, 60)),
        )
        for i in range(300)
    ]
    roster = [
        Operator(
            id=f"op{i}",
            name=f"Operator {i}",
            work_centers=rng.sample(names, rng.randint(2, 4)),
            shifts=[DAY_SHIFT if i % 2 else SECOND_SHIFT],
        )
        for i in range(40)
    ]
    request = ScheduleRequest(
        start_date=START, work_centers=work_centers, parts=parts, orders=orders, operators=roster, time_limit_s=5
    )
    plain = solve_schedule(request)
    from app.scheduler.assign import assign_operators
    from app.scheduler.staffing import staff

    staffed, report = staff(request)
    began = time.perf_counter()
    assignments, _ = assign_operators(request, staffed, plain.operations, report)
    elapsed = time.perf_counter() - began
    assert assignments
    assert elapsed < 3, elapsed
    assert_assignments_valid(request, plain.model_copy(update={"assignments": assignments}))
