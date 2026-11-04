"""Phase 3: people and material in the plan (F3.1, F3.2-R3/R4, F3.3)."""

import random
import time
from datetime import date, timedelta

import pytest

from app.models import (
    CapacityRequest,
    DayException,
    Operation,
    Operator,
    Order,
    Part,
    ScheduleRequest,
    ShiftWindow,
    WorkCenter,
)
from app.scheduler.capacity import check_capacity
from app.scheduler.cpsat_model import solve_schedule
from app.scheduler.staffing import HORIZON_DAYS, staff
from tests.plan_checks import assert_staffed_plan, assert_valid_plan
from tests.test_scheduler import random_shop

START = date(2026, 11, 2)  # a Monday
DAY_SHIFT = ShiftWindow(start="07:00", end="15:00")
SECOND_SHIFT = ShiftWindow(start="15:00", end="23:00")


def shop(*operators: Operator, **wc) -> ScheduleRequest:
    return ScheduleRequest(
        start_date=START,
        work_centers=[
            WorkCenter(name="VF2", hours_per_day=wc.pop("hours", 16), shifts=wc.pop("shifts", [DAY_SHIFT, SECOND_SHIFT]), **wc),
            WorkCenter(name="LATHE", hours_per_day=8),
        ],
        parts=[
            Part(part_no="P", routing=[Operation(seq=10, work_center="VF2", setup_min=0, run_min_per_unit=60)]),
            Part(part_no="L", routing=[Operation(seq=10, work_center="LATHE", setup_min=0, run_min_per_unit=60)]),
        ],
        orders=[],
        operators=list(operators),
    )


def staffed_minutes(request: ScheduleRequest, name: str, day: int = 0) -> float:
    return staff(request)[1].staffed_minutes.get((name, day), 0)


# --- Staffing rules ---------------------------------------------------------


def test_no_operators_changes_nothing():
    request = shop()
    staffed, report = staff(request)
    assert staffed is request
    assert report.notices == []


def test_machine_hours_are_what_its_people_cover():
    request = shop(Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT]))
    staffed, report = staff(request)
    assert report.machine_minutes[("VF2", 0)] == 960
    assert report.staffed_minutes[("VF2", 0)] == 480
    # The second shift is the part nobody covers.
    assert report.uncovered[("VF2", 0)] == [(15 * 60, 23 * 60)]
    vf2 = next(wc for wc in staffed.work_centers if wc.name == "VF2")
    assert vf2.hours_on(START) == 8
    assert staffed.operators == []


def test_two_people_on_both_shifts_staff_the_machine_fully():
    request = shop(
        Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT]),
        Operator(id="b", name="Bo", work_centers=["VF2"], shifts=[SECOND_SHIFT]),
    )
    staffed, report = staff(request)
    assert report.staffed_minutes[("VF2", 0)] == 960
    vf2 = next(wc for wc in staffed.work_centers if wc.name == "VF2")
    assert vf2.exceptions == []  # nothing cut


def test_only_overlapping_hours_count():
    # A night person on a day-shift machine covers nothing.
    request = shop(
        Operator(id="n", name="Nia", work_centers=["VF2"], shifts=[ShiftWindow(start="23:00", end="07:00")]),
        hours=8,
        shifts=[DAY_SHIFT],
    )
    assert staffed_minutes(request, "VF2") == 0


def test_overnight_shift_covers_the_next_morning():
    early = WorkCenter(name="VF2", hours_per_day=4, shifts=[ShiftWindow(start="02:00", end="06:00")])
    request = shop(Operator(id="n", name="Nia", work_centers=["VF2"], shifts=[ShiftWindow(days=[0, 1, 2, 3, 4], start="22:00", end="06:00")]))
    request.work_centers[0] = early
    _, report = staff(request)
    # Monday 02:00–06:00 has nobody (the shift starts Monday 22:00)…
    assert report.staffed_minutes[("VF2", 0)] == 0
    # …Tuesday 02:00–06:00 is covered by Monday night's shift.
    assert report.staffed_minutes[("VF2", 1)] == 240


def test_time_off():
    request = shop(
        Operator(
            id="a",
            name="Al",
            work_centers=["VF2"],
            shifts=[DAY_SHIFT],
            time_off=[DayException(date=START, hours=0), DayException(date=START + timedelta(days=1), hours=4)],
        )
    )
    _, report = staff(request)
    assert report.staffed_minutes[("VF2", 0)] == 0
    assert report.staffed_minutes[("VF2", 1)] == 240
    assert report.staffed_minutes[("VF2", 2)] == 480


def test_one_person_runs_two_machines_at_half_an_operator_each():
    request = shop(
        Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT]),
        hours=8,
        shifts=[DAY_SHIFT],
        operators_per_machine=0.5,
    )
    assert staffed_minutes(request, "VF2") == 480
    request.work_centers[0] = request.work_centers[0].model_copy(update={"operators_per_machine": 2})
    assert staffed_minutes(request, "VF2") == 240


def test_unattended_runs_need_someone_who_can_leave_it_running():
    lights_out = dict(hours=24, shifts=[ShiftWindow(start="00:00", end="00:00")], unattended_runs=True)
    can = Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT], unattended=True)
    cannot = Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT])
    assert staffed_minutes(shop(can, **lights_out), "VF2") == 24 * 60
    assert staffed_minutes(shop(cannot, **lights_out), "VF2") == 480


def test_a_machine_nobody_lists_keeps_its_hours_with_a_notice():
    request = shop(Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT]))
    staffed, report = staff(request)
    lathe = next(wc for wc in staffed.work_centers if wc.name == "LATHE")
    assert lathe.hours_on(START) == 8
    assert report.notices == ["No operator is listed for LATHE, so its hours aren't checked against people."]


def test_shared_people_follow_the_work():
    al = Operator(id="a", name="Al", work_centers=["VF2", "LATHE"])  # any time
    request = shop(al, hours=8, shifts=[DAY_SHIFT])
    request.orders = [
        Order(order_no="O1", part_no="P", qty=30, due_date=START + timedelta(days=9)),
        Order(order_no="O2", part_no="L", qty=10, due_date=START + timedelta(days=9)),
    ]
    _, report = staff(request)
    vf2, lathe = report.staffed_minutes[("VF2", 0)], report.staffed_minutes[("LATHE", 0)]
    # Al's 8 hours split 3:1, the way the work is (30 h on VF2, 10 h on the lathe).
    assert vf2 + lathe == pytest.approx(480)
    assert vf2 == pytest.approx(360)
    assert lathe == pytest.approx(120)


def test_the_fewest_qualified_go_first():
    # Bo only runs the lathe; Al runs both. Bo takes the lathe, Al the mill.
    request = shop(
        Operator(id="a", name="Al", work_centers=["VF2", "LATHE"]),
        Operator(id="b", name="Bo", work_centers=["LATHE"]),
        hours=8,
        shifts=[DAY_SHIFT],
    )
    request.orders = [
        Order(order_no="O1", part_no="P", qty=8, due_date=START + timedelta(days=9)),
        Order(order_no="O2", part_no="L", qty=8, due_date=START + timedelta(days=9)),
    ]
    _, report = staff(request)
    assert report.staffed_minutes[("VF2", 0)] == pytest.approx(480)
    assert report.staffed_minutes[("LATHE", 0)] == pytest.approx(480)


def test_more_people_never_mean_fewer_hours():
    rng = random.Random(5)
    for _ in range(10):
        request = random_shop(rng, orders=10)
        roster = random_roster(rng, request)
        fewer = staff(request.model_copy(update={"operators": roster[:-1]}))[1]
        more = staff(request.model_copy(update={"operators": roster}), extra_last={roster[-1].id})[1]
        for key, minutes in fewer.staffed_minutes.items():
            assert more.staffed_minutes.get(key, more.machine_minutes.get(key, 0)) >= minutes - 1e-6, key


def test_staffing_covers_the_plan_horizon_and_keeps_machine_hours_after_it():
    request = shop(Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT]))
    staffed, report = staff(request)
    vf2 = next(wc for wc in staffed.work_centers if wc.name == "VF2")
    assert report.days >= HORIZON_DAYS
    last_weekday = next(
        START + timedelta(days=d) for d in range(report.days - 1, 0, -1) if (START + timedelta(days=d)).weekday() < 5
    )
    assert vf2.hours_on(last_weekday) == 8
    # Past the staffed range the machine's own hours apply (documented).
    beyond = next(
        START + timedelta(days=d) for d in range(report.days, report.days + 7) if (START + timedelta(days=d)).weekday() < 5
    )
    assert vf2.hours_on(beyond) == 16


def test_machine_exception_wins_over_its_shifts():
    request = shop(Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT, SECOND_SHIFT]))
    request.work_centers[0].exceptions = [DayException(date=START, hours=0, reason="holiday")]
    _, report = staff(request)
    assert ("VF2", 0) not in report.machine_minutes
    assert report.staffed_minutes[("VF2", 1)] == 960


# --- Plans ------------------------------------------------------------------


def random_roster(rng: random.Random, request: ScheduleRequest) -> list[Operator]:
    names = [wc.name for wc in request.work_centers]
    shifts = [
        [DAY_SHIFT],
        [SECOND_SHIFT],
        [ShiftWindow(days=[0, 1, 2, 3], start="06:00", end="16:30")],
        [ShiftWindow(start="22:00", end="06:00")],
        [],
    ]
    roster = []
    for i in range(rng.randint(1, len(names) + 2)):
        roster.append(
            Operator(
                id=f"op{i}",
                name=f"Operator {i}",
                work_centers=rng.sample(names, rng.randint(1, len(names))),
                shifts=rng.choice(shifts),
                unattended=rng.random() < 0.2,
                time_off=[
                    DayException(date=START + timedelta(days=rng.randint(0, 20)), hours=rng.choice([0, 0, 4]))
                ],
            )
        )
    return roster


def with_releases(rng: random.Random, request: ScheduleRequest) -> ScheduleRequest:
    orders = [
        o.model_copy(update={"release_date": START + timedelta(days=rng.randint(1, 10))}) if rng.random() < 0.4 else o
        for o in request.orders
    ]
    return request.model_copy(update={"orders": orders})


def test_random_shops_with_rosters_never_overbook_people():
    rng = random.Random(23)
    for _ in range(8):
        request = with_releases(rng, random_shop(rng, orders=rng.randint(5, 15)))
        for wc in request.work_centers:
            wc.unattended_runs = rng.random() < 0.2
        request.operators = random_roster(rng, request)
        request.time_limit_s = 3
        response = solve_schedule(request)
        assert_staffed_plan(request, response)


def test_short_days_are_in_the_load_even_with_nothing_on_them():
    request = shop(Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT], time_off=[DayException(date=START, hours=0)]))
    request.orders = [Order(order_no="O1", part_no="P", qty=2, due_date=START + timedelta(days=5), release_date=START + timedelta(days=2))]
    response = solve_schedule(request)
    assert_staffed_plan(request, response)
    monday = next(d for d in response.load if d.work_center == "VF2" and d.date == START)
    assert (monday.capacity_minutes, monday.machine_minutes) == (0, 960)
    assert response.notices == ["No operator is listed for LATHE, so its hours aren't checked against people."]


def test_release_date_is_honoured_by_dispatch_and_cpsat(monkeypatch):
    request = shop()
    request.orders = [
        Order(order_no="A", part_no="P", qty=1, due_date=START),
        Order(order_no="B", part_no="P", qty=1, due_date=START, release_date=START + timedelta(days=3)),
    ]
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    b = next(op for op in response.operations if op.order_no == "B")
    assert b.start_date == START + timedelta(days=3)

    from ortools.sat.python import cp_model

    monkeypatch.setattr(cp_model.CpSolver, "solve", lambda self, *args: cp_model.UNKNOWN)
    greedy = solve_schedule(request)
    assert greedy.status == "HEURISTIC"
    assert_valid_plan(request, greedy)


# --- Capacity check -----------------------------------------------------------


def test_a_no_for_lack_of_people_says_so_and_offers_another_person():
    request = shop(Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT]), hourly_rate=95)
    result = check_capacity(
        CapacityRequest(**request.model_dump(), new_order=Order(order_no="N", part_no="P", qty=20, due_date=START + timedelta(days=1)))
    )
    assert not result.can_take
    assert "VF2 has people for 8 of its 16 hours on Mon Nov 2: no one qualified on it works 15:00–23:00." in result.explanation
    extra = next(lv for lv in result.levers if lv.kind == "extra_operator")
    assert extra.on_time
    assert extra.description.startswith("Another person qualified on VF2 working 15:00–23:00: done")
    assert extra.extra_cost is None  # what a person costs isn't known: not guessed


def test_overtime_lever_adds_hours_for_people_too():
    # Labor-bound: without people the machine's overtime can't be used.
    request = shop(Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT]), hours=8, shifts=[DAY_SHIFT], hourly_rate=100)
    result = check_capacity(
        CapacityRequest(**request.model_dump(), new_order=Order(order_no="N", part_no="P", qty=9, due_date=START))
    )
    overtime = next(lv for lv in result.levers if lv.kind == "overtime")
    assert overtime.on_time
    assert "and for the people who run them" in overtime.description


def test_material_sentence_and_expedite_lever():
    request = shop(Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT]))
    late = check_capacity(
        CapacityRequest(
            **request.model_dump(),
            new_order=Order(
                order_no="N",
                part_no="P",
                qty=4,
                due_date=START + timedelta(days=1),
                release_date=START + timedelta(days=3),
                release_note="arrives Thu Nov 5 on PO-4471",
            ),
        )
    )
    assert not late.can_take
    assert "Material: arrives Thu Nov 5 on PO-4471. Work on it can't start before Thu Nov 5." in late.explanation
    expedite = next(lv for lv in late.levers if lv.kind == "expedite_material")
    assert expedite.on_time
    assert expedite.description == (
        "Expedite the material: if it came today instead of Thu Nov 5, it would be done Mon Nov 2."
    )

    on_hand = check_capacity(
        CapacityRequest(
            **request.model_dump(),
            new_order=Order(
                order_no="N",
                part_no="P",
                qty=4,
                due_date=START + timedelta(days=5),
                release_note="12 ft of 2 in 6061 on hand",
            ),
        )
    )
    assert on_hand.can_take
    assert "Material: 12 ft of 2 in 6061 on hand." in on_hand.explanation
    assert not any(lv.kind == "expedite_material" for lv in on_hand.levers)


def test_no_lever_that_does_not_help():
    # Material is the only problem: another person changes nothing.
    request = shop(
        Operator(id="a", name="Al", work_centers=["VF2"], shifts=[DAY_SHIFT]),
        Operator(id="b", name="Bo", work_centers=["VF2"], shifts=[SECOND_SHIFT]),
    )
    result = check_capacity(
        CapacityRequest(
            **request.model_dump(),
            new_order=Order(order_no="N", part_no="P", qty=2, due_date=START, release_date=START + timedelta(days=2)),
        )
    )
    assert not any(lv.kind == "extra_operator" for lv in result.levers)
    assert any(lv.kind == "expedite_material" for lv in result.levers)


def test_capacity_check_on_a_big_shop_with_a_roster_is_fast():
    """F3.3-R6: 50 machines, 300 open jobs, a roster of 40: answered within
    the solver's budget. Generous bound so a busy machine doesn't flake."""
    rng = random.Random(3)
    names = [f"M{i:02d}" for i in range(50)]
    work_centers = [
        WorkCenter(name=n, hours_per_day=16, shifts=[DAY_SHIFT, SECOND_SHIFT], hourly_rate=80) for n in names
    ]
    parts = []
    for p in range(40):
        ops = [
            Operation(
                seq=(s + 1) * 10,
                work_center=rng.choice(names),
                setup_min=rng.randint(15, 60),
                run_min_per_unit=rng.choice([0.5, 1, 2, 4]),
                alt_work_centers=rng.sample(names, 1),
            )
            for s in range(rng.randint(2, 4))
        ]
        parts.append(Part(part_no=f"P{p}", routing=ops))
    orders = [
        Order(
            order_no=f"O{i}",
            part_no=rng.choice(parts).part_no,
            qty=rng.randint(10, 120),
            due_date=START + timedelta(days=rng.randint(3, 60)),
            release_date=START + timedelta(days=rng.randint(0, 5)) if rng.random() < 0.3 else None,
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
    request = CapacityRequest(
        start_date=START,
        work_centers=work_centers,
        parts=parts,
        orders=orders,
        operators=roster,
        time_limit_s=10,
        new_order=Order(order_no="NEW", part_no="P0", qty=50, due_date=START + timedelta(days=20)),
    )
    started = time.monotonic()
    result = check_capacity(request)
    took = time.monotonic() - started
    assert result.status in ("OPTIMAL", "FEASIBLE", "HEURISTIC", "UNKNOWN"), result.status
    assert result.new_order is not None
    assert took < 20, took
