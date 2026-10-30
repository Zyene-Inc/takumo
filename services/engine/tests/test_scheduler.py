from datetime import date

from fastapi.testclient import TestClient

from app.demo_shop import load_demo_shop
from app.main import app
from app.models import CapacityRequest, Order
from app.scheduler.calendar import date_to_day_index, day_index_to_date
from app.scheduler.capacity import check_capacity
from app.scheduler.cpsat_model import solve_schedule

START = date(2026, 11, 2)  # a Monday


def test_calendar_skips_weekends():
    assert day_index_to_date(START, 4) == date(2026, 11, 6)  # Friday
    assert day_index_to_date(START, 5) == date(2026, 11, 9)  # next Monday
    assert date_to_day_index(START, date(2026, 11, 8)) == 4  # Sunday → Friday


def test_demo_shop_schedules_on_time():
    response = solve_schedule(load_demo_shop(START))

    assert response.status in ("OPTIMAL", "FEASIBLE")
    assert {r.order_no for r in response.orders} == {
        "SO-5001", "SO-5002", "SO-5003", "SO-5004", "SO-5005", "SO-5006",
    }
    assert response.total_days_late == 0


def test_routing_sequence_is_respected():
    response = solve_schedule(load_demo_shop(START))
    ops = sorted(
        (op for op in response.operations if op.order_no == "SO-5005"),
        key=lambda op: op.seq,
    )
    for previous, current in zip(ops, ops[1:]):
        assert current.start_date >= previous.end_date


def test_small_order_can_be_taken():
    shop = load_demo_shop(START)
    request = CapacityRequest(
        **shop.model_dump(),
        new_order=Order(order_no="NEW-1", part_no="P-1001", qty=50, due_date=date(2026, 11, 27)),
    )

    result = check_capacity(request)

    assert result.can_take
    assert result.new_order is not None
    assert result.new_order.days_late == 0
    assert result.slipped == []


def test_huge_rush_order_cannot_be_taken():
    shop = load_demo_shop(START)
    request = CapacityRequest(
        **shop.model_dump(),
        new_order=Order(
            order_no="RUSH-1", part_no="P-2001", qty=400, due_date=date(2026, 11, 6), priority=3
        ),
    )

    result = check_capacity(request)

    assert not result.can_take
    assert any(lever.kind == "overtime" for lever in result.levers)
    assert "Not as planned" in result.explanation


def test_api_capacity_endpoint():
    shop = load_demo_shop(START)
    payload = shop.model_dump(mode="json")
    payload["new_order"] = {
        "order_no": "NEW-2",
        "part_no": "P-3001",
        "qty": 100,
        "due_date": "2026-11-27",
    }

    response = TestClient(app).post("/capacity", json=payload)

    assert response.status_code == 200
    assert response.json()["can_take"] is True


def test_unknown_part_is_rejected():
    shop = load_demo_shop(START)
    payload = shop.model_dump(mode="json")
    payload["orders"].append(
        {"order_no": "BAD", "part_no": "NOPE", "qty": 1, "due_date": "2026-11-27"}
    )

    response = TestClient(app).post("/schedule", json=payload)

    assert response.status_code == 422
