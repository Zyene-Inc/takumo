"""Loads seed/acme-precision CSVs into engine models (tests and local demos)."""

import csv
from datetime import date
from pathlib import Path

from app.models import (
    HistoryPart,
    Operation,
    Order,
    Part,
    PastQuote,
    ScheduleRequest,
    WorkCenter,
)

SEED_DIR = Path(__file__).resolve().parents[3] / "seed" / "acme-precision"


def _rows(name: str) -> list[dict[str, str]]:
    with (SEED_DIR / name).open(newline="") as file:
        return list(csv.DictReader(file))


def _number(value: str) -> float | None:
    return float(value) if value else None


def load_demo_quotes() -> tuple[list[PastQuote], list[HistoryPart]]:
    """Past quotes, and each quoted part's material and routing."""
    history = [
        PastQuote(
            quote_no=row["quote_no"],
            customer=row["customer"],
            part_no=row["part_no"],
            qty=int(row["qty"]),
            price=_number(row["price"]),
            est_cost=_number(row["est_cost"]),
            actual_cost=_number(row["actual_cost"]),
            status=row["status"],
            quoted_at=date.fromisoformat(row["quoted_at"]),
            lead_time_days=int(row["lead_time_days"]),
        )
        for row in _rows("quotes.csv")
    ]
    materials = {row["part_no"]: row["material"] for row in _rows("parts.csv")}
    routings = {p.part_no: p.routing for p in load_demo_shop(date.today()).parts}
    parts = [
        HistoryPart(part_no=part_no, material=material, routing=routings.get(part_no, []))
        for part_no, material in materials.items()
    ]
    return history, parts


def load_demo_shop(start_date: date) -> ScheduleRequest:
    work_centers = [
        WorkCenter(
            name=row["name"],
            hours_per_day=float(row["hours_per_day"]),
            efficiency=float(row["efficiency"]),
            hourly_rate=float(row["hourly_rate"]),
        )
        for row in _rows("work_centers.csv")
    ]

    routings: dict[str, list[Operation]] = {}
    for row in _rows("routings.csv"):
        routings.setdefault(row["part_no"], []).append(
            Operation(
                seq=int(row["seq"]),
                work_center=row["work_center"],
                setup_min=float(row["setup_min"]),
                run_min_per_unit=float(row["run_min_per_unit"]),
                alt_work_centers=[a for a in row["alt_work_centers"].split("|") if a],
            )
        )
    parts = [Part(part_no=part_no, routing=ops) for part_no, ops in routings.items()]

    orders = [
        Order(
            order_no=row["order_no"],
            part_no=row["part_no"],
            qty=int(row["qty"]),
            due_date=date.fromisoformat(row["due_date"]),
            priority=int(row["priority"]),
            price=float(row["price"]),
        )
        for row in _rows("orders.csv")
    ]

    return ScheduleRequest(
        start_date=start_date, work_centers=work_centers, parts=parts, orders=orders
    )
