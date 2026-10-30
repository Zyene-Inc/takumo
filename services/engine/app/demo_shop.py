"""Loads seed/acme-precision CSVs into engine models (tests and local demos)."""

import csv
from datetime import date
from pathlib import Path

from app.models import Operation, Order, Part, ScheduleRequest, WorkCenter

SEED_DIR = Path(__file__).resolve().parents[3] / "seed" / "acme-precision"


def _rows(name: str) -> list[dict[str, str]]:
    with (SEED_DIR / name).open(newline="") as file:
        return list(csv.DictReader(file))


def load_demo_shop(start_date: date) -> ScheduleRequest:
    work_centers = [
        WorkCenter(
            name=row["name"],
            hours_per_day=float(row["hours_per_day"]),
            efficiency=float(row["efficiency"]),
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
        )
        for row in _rows("orders.csv")
    ]

    return ScheduleRequest(
        start_date=start_date, work_centers=work_centers, parts=parts, orders=orders
    )
