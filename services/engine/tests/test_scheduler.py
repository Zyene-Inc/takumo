import random
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.demo_shop import load_demo_shop
from app.main import app
from app.models import (
    CapacityRequest,
    DayException,
    Operation,
    Order,
    Part,
    Pin,
    ScheduleRequest,
    WorkCenter,
)
from app.scheduler.calendar import Timeline
from app.scheduler.capacity import check_capacity
from app.scheduler.cpsat_model import solve_schedule
from app.scheduler.dispatch import dispatch
from tests.plan_checks import assert_valid_plan

START = date(2026, 11, 2)  # a Monday


def one_machine_shop(hours=8.0, **wc) -> ScheduleRequest:
    return ScheduleRequest(
        start_date=START,
        work_centers=[WorkCenter(name="M1", hours_per_day=hours, **wc)],
        parts=[Part(part_no="P", routing=[Operation(seq=10, work_center="M1", setup_min=0, run_min_per_unit=60)])],
        orders=[],
    )


# --- Calendar -------------------------------------------------------------


def test_timeline_skips_weekends_and_holidays():
    wc = WorkCenter(
        name="M1",
        hours_per_day=8,
        exceptions=[DayException(date=date(2026, 11, 4), hours=0, reason="holiday")],
    )
    t = Timeline(wc, START, 1.0)
    t.ensure(14)
    assert t.minutes[:7] == [480, 480, 0, 480, 480, 0, 0]
    assert t.day_of(960) == 3  # third working minute-block is Thursday
    assert t.pos_at_or_after(2 * 1440) == 960  # Wednesday (closed) → Thursday start


def test_efficiency_and_overtime_scale_capacity():
    wc = WorkCenter(name="M1", hours_per_day=10, efficiency=0.9)
    t = Timeline(wc, START, 1.25)
    t.ensure(1)
    assert t.minutes[0] == round(10 * 60 * 0.9 * 1.25)
    # 30 clock minutes in = 30 * 0.9 * 1.25 capacity minutes.
    assert t.abs_start(t.pos_at_or_after(30)) == 30


def test_saturday_shift_and_custom_working_days():
    request = one_machine_shop(working_days=[0, 1, 2, 3, 4, 5])
    request.orders = [Order(order_no="A", part_no="P", qty=48, due_date=date(2026, 11, 7))]
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    # 48 h of work at 8 h/day, Monday–Saturday → done Saturday.
    assert response.orders[0].completion_date == date(2026, 11, 7)
    assert response.orders[0].days_late == 0


def test_downtime_pushes_work_out():
    request = one_machine_shop(
        exceptions=[DayException(date=START + timedelta(days=i), hours=0) for i in range(2)]
    )
    request.orders = [Order(order_no="A", part_no="P", qty=8, due_date=START)]
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    assert response.operations[0].start_date == date(2026, 11, 4)
    assert response.orders[0].days_late == 2


def test_long_operation_runs_across_the_weekend():
    request = one_machine_shop()
    request.orders = [Order(order_no="A", part_no="P", qty=56, due_date=date(2026, 11, 30))]
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    op = response.operations[0]
    assert op.start_at == datetime(2026, 11, 2, 7, 0)
    # 7 working days of 8 h: Mon–Fri, then Mon–Tue.
    assert op.end_date == date(2026, 11, 10)
    assert op.end_at == datetime(2026, 11, 10, 15, 0)


# --- Scheduling -----------------------------------------------------------


def test_demo_shop_schedules_on_time():
    request = load_demo_shop(START)
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    assert response.status in ("OPTIMAL", "FEASIBLE")
    assert {r.order_no for r in response.orders} == {
        "SO-5001", "SO-5002", "SO-5003", "SO-5004", "SO-5005", "SO-5006",
    }
    assert response.total_days_late == 0


def test_next_operation_waits_for_the_clock_time_not_just_the_day():
    request = ScheduleRequest(
        start_date=START,
        work_centers=[
            WorkCenter(name="MILL", hours_per_day=8),
            WorkCenter(name="DEBURR", hours_per_day=8),
        ],
        parts=[
            Part(
                part_no="P",
                routing=[
                    Operation(seq=10, work_center="MILL", setup_min=0, run_min_per_unit=300),
                    Operation(seq=20, work_center="DEBURR", setup_min=0, run_min_per_unit=60),
                ],
            )
        ],
        orders=[Order(order_no="A", part_no="P", qty=1, due_date=date(2026, 11, 30))],
    )
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    mill, deburr = sorted(response.operations, key=lambda op: op.seq)
    assert mill.end_at == datetime(2026, 11, 2, 12, 0)
    assert deburr.start_at >= mill.end_at
    assert deburr.start_date == START  # same day, after the mill finishes


def test_alternate_machine_used_when_primary_is_full():
    request = ScheduleRequest(
        start_date=START,
        work_centers=[WorkCenter(name="A", hours_per_day=8), WorkCenter(name="B", hours_per_day=8)],
        parts=[
            Part(
                part_no="P",
                routing=[
                    Operation(seq=10, work_center="A", setup_min=0, run_min_per_unit=480, alt_work_centers=["B"])
                ],
            )
        ],
        orders=[
            Order(order_no="O1", part_no="P", qty=1, due_date=START),
            Order(order_no="O2", part_no="P", qty=1, due_date=START),
        ],
    )
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    assert {op.work_center for op in response.operations} == {"A", "B"}
    assert response.total_days_late == 0


def test_priority_wins_when_capacity_is_short():
    request = one_machine_shop()
    request.orders = [
        Order(order_no="LOW", part_no="P", qty=8, due_date=START),
        Order(order_no="HIGH", part_no="P", qty=8, due_date=START, priority=5),
    ]
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    late = {r.order_no: r.days_late for r in response.orders}
    assert late == {"HIGH": 0, "LOW": 1}


def test_pinned_operation_stays_put():
    request = load_demo_shop(START)
    pin_day = date(2026, 11, 10)
    request.pins = [Pin(order_no="SO-5004", seq=10, work_center="HAAS-VF2", start_date=pin_day)]
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    op = next(o for o in response.operations if o.order_no == "SO-5004" and o.seq == 10)
    assert op.pinned and op.work_center == "HAAS-VF2" and op.start_date == pin_day


def test_conflicting_pins_are_reported():
    request = one_machine_shop()
    request.orders = [
        # 9 h each on an 8 h machine: only one of them can start on Monday.
        Order(order_no="A", part_no="P", qty=9, due_date=date(2026, 11, 30)),
        Order(order_no="B", part_no="P", qty=9, due_date=date(2026, 11, 30)),
    ]
    request.pins = [
        Pin(order_no="A", seq=10, work_center="M1", start_date=START),
        Pin(order_no="B", seq=10, work_center="M1", start_date=START),
    ]
    response = solve_schedule(request)
    assert response.status == "INFEASIBLE"
    assert any("full" in c.message for c in response.conflicts)


def test_pin_on_a_closed_day_is_reported():
    request = one_machine_shop()
    request.orders = [Order(order_no="A", part_no="P", qty=1, due_date=date(2026, 11, 30))]
    request.pins = [Pin(order_no="A", seq=10, work_center="M1", start_date=date(2026, 11, 7))]
    response = solve_schedule(request)
    assert response.status == "INFEASIBLE"
    assert "isn't running" in response.conflicts[0].message


def test_pin_to_a_machine_the_routing_does_not_allow_is_rejected():
    request = load_demo_shop(START)
    request.pins = [Pin(order_no="SO-5001", seq=20, work_center="HAAS-VF2", start_date=START)]
    with pytest.raises(ValueError, match="can't run on"):
        solve_schedule(request)


def test_dispatch_plan_is_valid_on_random_shops():
    rng = random.Random(7)
    for _ in range(15):
        request = random_shop(rng, orders=rng.randint(5, 25))
        parts = {p.part_no: p for p in request.parts}
        timelines = {wc.name: Timeline(wc, START, 1.0) for wc in request.work_centers}
        for t in timelines.values():
            t.ensure(60)
        greedy = dispatch(request, timelines, parts)
        from app.scheduler.cpsat_model import build_response

        assert not greedy.conflicts
        assert_valid_plan(request, build_response(request, "HEURISTIC", greedy.placements, timelines))


def test_cpsat_plan_is_valid_and_no_worse_than_dispatch_on_random_shops():
    rng = random.Random(11)
    for _ in range(6):
        request = random_shop(rng, orders=rng.randint(5, 15))
        request.time_limit_s = 5
        response = solve_schedule(request)
        assert_valid_plan(request, response)

        parts = {p.part_no: p for p in request.parts}
        timelines = {wc.name: Timeline(wc, START, 1.0) for wc in request.work_centers}
        for t in timelines.values():
            t.ensure(60)
        from app.scheduler.cpsat_model import build_response

        greedy = build_response(request, "HEURISTIC", dispatch(request, timelines, parts).placements, timelines)
        weight = {o.order_no: o.priority + 1 for o in request.orders}
        score = lambda r: sum(weight[o.order_no] * o.days_late for o in r.orders)  # noqa: E731
        assert score(response) <= score(greedy)


def test_timeout_falls_back_to_the_dispatch_plan(monkeypatch):
    from ortools.sat.python import cp_model

    monkeypatch.setattr(cp_model.CpSolver, "solve", lambda self, *args: cp_model.UNKNOWN)
    request = load_demo_shop(START)
    response = solve_schedule(request)
    assert response.status == "HEURISTIC"
    assert_valid_plan(request, response)


# --- Capacity check -------------------------------------------------------


def test_small_order_can_be_taken():
    shop = load_demo_shop(START)
    result = check_capacity(
        CapacityRequest(
            **shop.model_dump(),
            new_order=Order(order_no="NEW-1", part_no="P-1001", qty=50, due_date=date(2026, 11, 27), price=2500),
        )
    )
    assert result.can_take
    assert result.new_order and result.new_order.days_late == 0
    assert result.slipped == []
    assert result.explanation.startswith("Yes.")
    # 45 min setup + 50 × 6 min on a $95 mill, 10 + 50 × 1.5 min on a $45 deburr.
    assert result.cost and result.cost.machine == pytest.approx(345 / 60 * 95 + 85 / 60 * 45, abs=0.01)
    assert "material cost for P-1001" in result.cost.missing


def test_huge_rush_order_cannot_be_taken():
    shop = load_demo_shop(START)
    result = check_capacity(
        CapacityRequest(
            **shop.model_dump(),
            new_order=Order(order_no="RUSH-1", part_no="P-2001", qty=400, due_date=date(2026, 11, 6), priority=3),
        )
    )
    assert not result.can_take
    assert result.new_order and result.new_order.days_late > 0
    assert {lv.kind for lv in result.levers} >= {"overtime", "split_lot"}
    assert result.explanation.startswith("Not without changes")


def test_rush_shows_which_orders_slip():
    request = one_machine_shop()
    request.orders = [Order(order_no="EXISTING", part_no="P", qty=8, due_date=START)]
    result = check_capacity(
        CapacityRequest(
            **request.model_dump(),
            new_order=Order(order_no="NEW", part_no="P", qty=8, due_date=START),
        )
    )
    assert not result.can_take
    assert result.new_order and result.new_order.days_late == 1  # fitted after EXISTING
    assert result.rush and result.rush.days_late == 0  # going first makes it…
    assert [s.order_no for s in result.slipped] == ["EXISTING"]  # …but EXISTING slips
    assert "pushes back EXISTING" in result.explanation


def test_overtime_lever_makes_the_date_and_is_costed():
    request = one_machine_shop(hourly_rate=100)
    request.orders = [Order(order_no="EXISTING", part_no="P", qty=8, due_date=START)]
    result = check_capacity(
        CapacityRequest(
            **request.model_dump(),
            new_order=Order(order_no="NEW", part_no="P", qty=8, due_date=START + timedelta(days=3)),
        )
    )
    # 8 h existing + 8 h new by Thursday is easy; make it tight instead:
    assert result.can_take

    tight = check_capacity(
        CapacityRequest(
            **request.model_dump(),
            new_order=Order(order_no="NEW", part_no="P", qty=2, due_date=START),
        )
    )
    assert not tight.can_take
    overtime = next(lv for lv in tight.levers if lv.kind == "overtime")
    assert overtime.on_time
    assert overtime.extra_cost == pytest.approx(2 * 100 * 0.5)  # 2 h at a 50% premium
    assert tight.levers[0].kind == "overtime"  # cheapest on-time lever first


def test_split_lot_lever():
    request = ScheduleRequest(
        start_date=START,
        work_centers=[WorkCenter(name="A", hours_per_day=8, hourly_rate=60), WorkCenter(name="B", hours_per_day=8, hourly_rate=60)],
        parts=[
            Part(
                part_no="P",
                routing=[Operation(seq=10, work_center="A", setup_min=30, run_min_per_unit=30, alt_work_centers=["B"])],
            )
        ],
        orders=[],
    )
    # 30 units = 15.5 h on one machine (2 days); split across A and B it's one day.
    result = check_capacity(
        CapacityRequest(
            **request.model_dump(),
            new_order=Order(order_no="NEW", part_no="P", qty=30, due_date=START),
        )
    )
    assert not result.can_take
    split = next(lv for lv in result.levers if lv.kind == "split_lot")
    assert split.on_time
    assert split.extra_cost == pytest.approx(30)  # one more 30-min setup at $60/h


def test_margin_uses_material_and_price():
    shop = load_demo_shop(START)
    for part in shop.parts:
        part.material_cost = 10
    result = check_capacity(
        CapacityRequest(
            **shop.model_dump(),
            new_order=Order(order_no="NEW", part_no="P-1001", qty=50, due_date=date(2026, 11, 27), price=2500),
        )
    )
    cost = result.cost
    assert cost and cost.material == 500 and cost.missing == []
    assert cost.total == pytest.approx(cost.machine + 500)
    assert cost.margin == pytest.approx(2500 - cost.total)
    assert "margin" in result.explanation


def test_duplicate_new_order_number_is_rejected():
    shop = load_demo_shop(START)
    with pytest.raises(ValueError, match="already exists"):
        check_capacity(
            CapacityRequest(
                **shop.model_dump(),
                new_order=Order(order_no="SO-5001", part_no="P-1001", qty=1, due_date=date(2026, 11, 27)),
            )
        )


# --- API ------------------------------------------------------------------


def test_api_capacity_endpoint():
    payload = load_demo_shop(START).model_dump(mode="json")
    payload["new_order"] = {"order_no": "NEW-2", "part_no": "P-3001", "qty": 100, "due_date": "2026-11-27"}
    response = TestClient(app).post("/capacity", json=payload)
    assert response.status_code == 200
    assert response.json()["can_take"] is True


def test_api_schedule_returns_load_and_clock_times():
    payload = load_demo_shop(START).model_dump(mode="json")
    response = TestClient(app).post("/schedule", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["load"] and body["operations"][0]["start_at"].startswith("2026-11-")


def test_unknown_part_is_rejected():
    payload = load_demo_shop(START).model_dump(mode="json")
    payload["orders"].append({"order_no": "BAD", "part_no": "NOPE", "qty": 1, "due_date": "2026-11-27"})
    response = TestClient(app).post("/schedule", json=payload)
    assert response.status_code == 422


def test_secret_is_required_when_configured(monkeypatch):
    monkeypatch.setenv("ENGINE_SECRET", "s3cret")
    client = TestClient(app)
    payload = load_demo_shop(START).model_dump(mode="json")
    assert client.post("/schedule", json=payload).status_code == 401
    assert client.post("/schedule", json=payload, headers={"X-Engine-Secret": "s3cret"}).status_code == 200


# --- Helpers --------------------------------------------------------------


def random_shop(rng: random.Random, orders: int) -> ScheduleRequest:
    names = [f"WC{i}" for i in range(rng.randint(2, 5))]
    work_centers = [
        WorkCenter(
            name=n,
            hours_per_day=rng.choice([8, 10, 16]),
            efficiency=rng.choice([0.85, 0.9, 1.0]),
            exceptions=[DayException(date=START + timedelta(days=rng.randint(0, 20)), hours=0)],
        )
        for n in names
    ]
    parts = []
    for p in range(rng.randint(2, 6)):
        ops = []
        for s in range(rng.randint(1, 4)):
            primary = rng.choice(names)
            alts = [n for n in names if n != primary and rng.random() < 0.3]
            ops.append(
                Operation(
                    seq=(s + 1) * 10,
                    work_center=primary,
                    setup_min=rng.randint(0, 90),
                    run_min_per_unit=rng.choice([0.5, 1, 2.5, 6, 12]),
                    alt_work_centers=alts,
                )
            )
        parts.append(Part(part_no=f"P{p}", routing=ops))
    return ScheduleRequest(
        start_date=START,
        work_centers=work_centers,
        parts=parts,
        orders=[
            Order(
                order_no=f"O{i}",
                part_no=rng.choice(parts).part_no,
                qty=rng.randint(1, 200),
                due_date=START + timedelta(days=rng.randint(-2, 30)),
                priority=rng.choice([0, 0, 1, 2]),
            )
            for i in range(orders)
        ],
    )


def test_capacity_check_still_answers_when_the_solver_times_out(monkeypatch):
    from ortools.sat.python import cp_model

    monkeypatch.setattr(cp_model.CpSolver, "solve", lambda self, *args: cp_model.UNKNOWN)
    shop = load_demo_shop(START)
    result = check_capacity(
        CapacityRequest(
            **shop.model_dump(),
            new_order=Order(order_no="NEW", part_no="P-1001", qty=50, due_date=date(2026, 11, 27)),
        )
    )
    # The baseline with the new order fitted into its gaps: nobody moves.
    assert result.status == "HEURISTIC"
    assert result.can_take and result.slipped == []


def test_rush_plan_keeps_other_orders_close_to_the_baseline():
    shop = load_demo_shop(START)
    result = check_capacity(
        CapacityRequest(
            **shop.model_dump(),
            new_order=Order(order_no="RUSH", part_no="P-1001", qty=300, due_date=date(2026, 11, 4)),
        )
    )
    assert result.rush is not None
    # Only orders that really lose time are listed, each with a positive slip.
    assert all(s.days_late_after > s.days_late_before for s in result.slipped)
