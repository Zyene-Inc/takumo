from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.demo_shop import load_demo_quotes, load_demo_shop
from app.main import app
from app.models import (
    Operation,
    Order,
    OutsideProcess,
    Part,
    PastQuote,
    QuoteMaterial,
    QuoteOperation,
    QuoteRequest,
    QuoteSpec,
    ScheduleRequest,
    WorkCenter,
)
from app.quote.cost_model import margin_policy, other_cost, price_at
from app.quote.estimate import estimate_quote
from app.scheduler.cpsat_model import solve_schedule
from tests.plan_checks import assert_valid_plan

START = date(2026, 11, 2)  # a Monday


def demo_request(spec: QuoteSpec, lead_times=True) -> QuoteRequest:
    shop = load_demo_shop(START)
    history, history_parts = load_demo_quotes()
    return QuoteRequest(
        **shop.model_dump(),
        quote=spec,
        history=history,
        history_parts=history_parts,
        lead_times=lead_times,
    )


def routing_of(part_no: str) -> list[QuoteOperation]:
    part = next(p for p in load_demo_shop(START).parts if p.part_no == part_no)
    return [QuoteOperation(**op.model_dump()) for op in part.routing]


AL = QuoteMaterial(name="AL6061-T6 bar 2in", unit="ft", unit_cost=18.5, lead_time_days=3)


# --- Material release dates -------------------------------------------------


def test_nothing_starts_before_the_material_arrives():
    request = ScheduleRequest(
        start_date=START,
        work_centers=[WorkCenter(name="M1", hours_per_day=8)],
        parts=[Part(part_no="P", routing=[Operation(seq=10, work_center="M1", setup_min=0, run_min_per_unit=60)])],
        orders=[
            Order(order_no="A", part_no="P", qty=4, due_date=START, release_date=date(2026, 11, 5)),
        ],
    )
    response = solve_schedule(request)
    assert_valid_plan(request, response)
    assert response.operations[0].start_date == date(2026, 11, 5)


# --- Cost model -------------------------------------------------------------


def test_machine_cost_uses_efficiency_and_rate():
    spec = QuoteSpec(part_no="P-1001", material=AL, routing=routing_of("P-1001"), qty_breaks=[100])
    result = estimate_quote(demo_request(spec, lead_times=False))
    machine = [line for line in result.breaks[0].lines if line.kind == "machine"]
    # HAAS-VF2: (45 + 6 × 100) / 0.9 min at $95/h; DEBURR-1: (10 + 1.5 × 100) min at $45/h.
    assert machine[0].amount == pytest.approx(645 / 0.9 / 60 * 95, abs=0.01)
    assert machine[1].amount == pytest.approx(160 / 60 * 45, abs=0.01)
    assert "routing P-1001 op 10" in machine[0].sources


def test_material_is_calibrated_from_actual_costs_of_the_same_part():
    spec = QuoteSpec(part_no="P-1001", material=AL, routing=routing_of("P-1001"), qty_breaks=[100])
    history, parts = load_demo_quotes()
    wcs = {wc.name: wc for wc in load_demo_shop(START).work_centers}
    other = other_cost(spec, history, {p.part_no: p for p in parts}, wcs)
    # Q-9001: 100 pcs cost $3,350; Q-9002: 250 pcs cost $7,600. Less machine time, per part.
    def machine(qty):
        return (45 + 6 * qty) / 0.9 / 60 * 95 + (10 + 1.5 * qty) / 60 * 45
    expected = ((3350 - machine(100)) / 100 + (7600 - machine(250)) / 250) / 2
    assert other.per_unit == pytest.approx(expected)
    assert other.sources == ["quote Q-9001", "quote Q-9002"]
    assert other.warning is None


def test_stated_stock_usage_overrides_history():
    spec = QuoteSpec(
        part_no="P-1001",
        material=AL.model_copy(update={"usage_per_part": 0.5}),
        routing=routing_of("P-1001"),
        qty_breaks=[100],
    )
    result = estimate_quote(demo_request(spec, lead_times=False))
    material = next(line for line in result.breaks[0].lines if line.kind == "material")
    assert material.amount == pytest.approx(0.5 * 18.5 * 100)
    assert "0.5 ft" in material.basis


def test_new_part_borrows_from_the_same_material_with_a_warning():
    spec = QuoteSpec(
        part_no="NEW-1",
        material=AL,
        routing=[QuoteOperation(seq=10, work_center="HAAS-VF2", setup_min=50, run_min_per_unit=7, source="comparable")],
        qty_breaks=[100],
    )
    result = estimate_quote(demo_request(spec, lead_times=False))
    assert result.missing == []
    assert any("No cost history for NEW-1" in w for w in result.warnings)
    machine = result.breaks[0].lines[0]
    assert machine.sources == ["machine HAAS-VF2"]  # not a shop routing, so not cited as one
    assert "similar part" in machine.basis


def test_no_history_and_no_usage_means_no_price():
    spec = QuoteSpec(
        part_no="NEW-2",
        material=QuoteMaterial(name="Ti-6Al-4V bar", unit="ft"),
        routing=[QuoteOperation(seq=10, work_center="HAAS-VF2", setup_min=50, run_min_per_unit=7)],
        qty_breaks=[10],
    )
    result = estimate_quote(demo_request(spec, lead_times=False))
    assert result.breaks[0].price is None
    assert any("material cost" in m for m in result.missing)


def test_target_margin_is_the_customers_median_actual_margin():
    history, _ = load_demo_quotes()
    spec = QuoteSpec(part_no="P-1001", customer="Northwind Robotics", routing=routing_of("P-1001"), qty_breaks=[1])
    policy = margin_policy(spec, history)
    # Northwind's won quotes: Q-9001 (4500 − 3350) / 4500 and Q-9002 (10000 − 7600) / 10000.
    assert policy.target == pytest.approx(((1150 / 4500) + 0.24) / 2)
    assert policy.sources == ["quote Q-9001", "quote Q-9002"]
    # A customer with one won quote gets the shop's margins.
    shop = margin_policy(spec.model_copy(update={"customer": "Bluefin Marine"}), history)
    assert len(shop.sources) == 5 and "the shop's" in shop.basis


def test_a_zero_actual_cost_is_not_a_hundred_percent_margin():
    day = date(2026, 10, 1)
    history = [
        PastQuote(quote_no="Q1", qty=1, price=100, actual_cost=0, status="won", quoted_at=day),
        PastQuote(quote_no="Q2", qty=1, price=100, actual_cost=70, status="won", quoted_at=day),
    ]
    spec = QuoteSpec(part_no="P-1001", routing=routing_of("P-1001"), qty_breaks=[1])
    policy = margin_policy(spec, history)
    assert policy.sources == ["quote Q2"]
    assert policy.high == pytest.approx(0.3)
    assert price_at(100, 1.0, 1)[0] == 1000  # capped at 90%, never divides by zero


def test_estimators_margin_overrides_history():
    spec = QuoteSpec(part_no="P-1001", material=AL, routing=routing_of("P-1001"), qty_breaks=[100], target_margin=0.3)
    row = estimate_quote(demo_request(spec, lead_times=False)).breaks[0]
    assert row.unit_price == round(row.cost / 0.7 / 100, 2)
    assert row.margin_pct == pytest.approx(0.3, abs=0.001)


def test_price_holds_together_for_every_quantity():
    spec = QuoteSpec(
        part_no="P-1001", customer="Northwind Robotics", material=AL,
        routing=routing_of("P-1001"), qty_breaks=[250, 50, 100],
    )
    result = estimate_quote(demo_request(spec, lead_times=False))
    assert [b.qty for b in result.breaks] == [50, 100, 250]
    for row in result.breaks:
        assert row.cost == pytest.approx(sum(line.amount for line in row.lines), abs=0.01)
        assert row.price == pytest.approx(row.unit_price * row.qty, abs=0.01)
        assert row.price_low <= row.price <= row.price_high
    # Setup is spread over more parts, so bigger lots are cheaper per part.
    units = [b.unit_price for b in result.breaks]
    assert units == sorted(units, reverse=True)


def test_outside_processing_is_added_or_flagged():
    spec = QuoteSpec(
        part_no="P-1001", material=AL, routing=routing_of("P-1001"), qty_breaks=[100],
        outside=[
            OutsideProcess(description="Anodize, Type II black", cost_per_lot=150, cost_per_unit=1.2),
            OutsideProcess(description="Laser marking"),
        ],
    )
    result = estimate_quote(demo_request(spec, lead_times=False))
    anodize = next(line for line in result.breaks[0].lines if line.kind == "outside")
    assert anodize.amount == pytest.approx(150 + 120)
    assert result.warnings == ["Not priced yet: Laser marking (outside process)."]
    assert result.breaks[0].price is not None


def test_missing_rate_blocks_the_price():
    spec = QuoteSpec(part_no="P-1001", material=AL, routing=routing_of("P-1001"), qty_breaks=[100])
    request = demo_request(spec, lead_times=False)
    for wc in request.work_centers:
        if wc.name == "DEBURR-1":
            wc.hourly_rate = None
    result = estimate_quote(request)
    assert result.breaks[0].price is None
    assert "hourly rate for DEBURR-1" in result.missing


def test_bad_quantities_are_rejected():
    spec = QuoteSpec(part_no="P-1001", routing=routing_of("P-1001"), qty_breaks=[100, 100])
    with pytest.raises(ValueError):
        estimate_quote(demo_request(spec, lead_times=False))


# --- Comparables and checks -------------------------------------------------


def test_comparables_rank_the_same_part_first_with_reasons():
    spec = QuoteSpec(part_no="P-1001", customer="Northwind Robotics", material=AL, routing=routing_of("P-1001"), qty_breaks=[200])
    result = estimate_quote(demo_request(spec, lead_times=False))
    top = result.comparables[:2]
    assert {c.quote_no for c in top} == {"Q-9001", "Q-9002"}
    assert "same part" in top[0].reasons and "same customer" in top[0].reasons
    q9002 = next(c for c in result.comparables if c.quote_no == "Q-9002")
    assert q9002.unit_price == 40.0 and q9002.margin_basis == "actual"
    # P-1002 is the other AL6061 part on the same machines.
    assert any(c.part_no == "P-1002" for c in result.comparables)
    assert result.checks and "Q-9002" in " ".join(result.checks)


def test_new_part_finds_parts_on_the_same_machines():
    spec = QuoteSpec(
        part_no="NEW-3",
        material=QuoteMaterial(name="SS316 bar 1.5in", unit="ft", unit_cost=42),
        routing=[QuoteOperation(seq=10, work_center="OKUMA-LB3000", setup_min=80, run_min_per_unit=11)],
        qty_breaks=[60],
    )
    result = estimate_quote(demo_request(spec, lead_times=False))
    assert {c.part_no for c in result.comparables} <= {"P-2001", "P-2002"}
    assert result.comparables and result.checks == []


# --- Lead times -------------------------------------------------------------


def test_lead_time_fits_around_the_plan_and_waits_for_material():
    spec = QuoteSpec(
        part_no="P-1001", customer="Northwind Robotics", material=AL,
        routing=routing_of("P-1001"), qty_breaks=[50, 400],
        requested_date=date(2026, 11, 13),
    )
    result = estimate_quote(demo_request(spec))
    assert result.status in ("OPTIMAL", "FEASIBLE", "HEURISTIC")
    small, big = result.breaks
    assert small.lead_time_days is not None and big.lead_time_days is not None
    # Material in Nov 5 (3-day lead time), so nothing finishes before then.
    assert small.completion_date >= START + timedelta(days=3)
    assert small.lead_time_days == (small.completion_date - START).days
    assert big.completion_date >= small.completion_date
    assert small.meets_requested is True
    assert "AL6061-T6 bar 2in in 3 days" in result.lead_time_note


def test_api_quote_endpoint():
    spec = QuoteSpec(part_no="P-2001", customer="Bluefin Marine", routing=routing_of("P-2001"), qty_breaks=[40])
    client = TestClient(app)
    response = client.post("/quote", json=demo_request(spec, lead_times=False).model_dump(mode="json"))
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "PRICE_ONLY"
    assert body["breaks"][0]["unit_price"] > 0


def test_api_rejects_an_unknown_machine_without_scheduling():
    spec = QuoteSpec(
        part_no="NEW-4", material=AL,
        routing=[QuoteOperation(seq=10, work_center="NOPE", setup_min=1, run_min_per_unit=1)],
        qty_breaks=[5],
    )
    result = estimate_quote(demo_request(spec))
    assert result.status == "PRICE_ONLY"
    assert any("NOPE" in m for m in result.missing)
