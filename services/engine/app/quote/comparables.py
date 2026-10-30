"""Past quotes most like the one being drafted, with the reasons why.

Scored on what drives price in a job shop: the same part, the same material,
the same machines (process), a similar quantity, the same customer. Each
comparable carries its unit price, outcome and margin, so an estimator can
see the evidence behind a suggested price.
"""

import math

from app.models import Comparable, HistoryPart, PastQuote, QuoteSpec

MAX_COMPARABLES = 5
MIN_SCORE = 0.2

WEIGHTS = {"part": 0.5, "material": 0.2, "process": 0.15, "customer": 0.1, "qty": 0.05}


def margin_of(quote: PastQuote) -> tuple[float | None, str | None]:
    """Actual margin when the job's real cost is known, else the quoted one."""
    if not quote.price:
        return None, None
    if quote.actual_cost is not None:
        return (quote.price - quote.actual_cost) / quote.price, "actual"
    if quote.est_cost is not None:
        return (quote.price - quote.est_cost) / quote.price, "estimated"
    return None, None


def _machines(routing) -> set[str]:
    """Every machine the routing can run on, alternates included."""
    return {name for op in routing for name in [op.work_center, *op.alt_work_centers]}


def find_comparables(
    spec: QuoteSpec,
    history: list[PastQuote],
    parts: dict[str, HistoryPart],
    qty: int,
) -> list[Comparable]:
    target_material = spec.material.name if spec.material else None
    target_machines = _machines(spec.routing)
    found: list[Comparable] = []
    for quote in history:
        part = parts.get(quote.part_no or "")
        score = 0.0
        reasons: list[str] = []
        if quote.part_no and quote.part_no == spec.part_no:
            score += WEIGHTS["part"]
            reasons.append("same part")
        material = part.material if part else None
        if target_material and material == target_material:
            score += WEIGHTS["material"]
            reasons.append(f"same material ({material})")
        if part and part.routing and quote.part_no != spec.part_no:
            machines = _machines(part.routing)
            overlap = len(machines & target_machines) / len(machines | target_machines)
            if overlap > 0:
                score += WEIGHTS["process"] * overlap
                shared = ", ".join(sorted(machines & target_machines))
                reasons.append(f"same machines ({shared})")
        elif quote.part_no == spec.part_no:
            score += WEIGHTS["process"]
        if spec.customer and quote.customer == spec.customer:
            score += WEIGHTS["customer"]
            reasons.append("same customer")
        # 1 at the same quantity, 0 at 10× more or less.
        closeness = max(0.0, 1 - abs(math.log(quote.qty / qty)) / math.log(10))
        score += WEIGHTS["qty"] * closeness
        if closeness >= 0.7:
            reasons.append(f"similar quantity ({quote.qty:,})")
        if score < MIN_SCORE:
            continue
        margin, basis = margin_of(quote)
        found.append(
            Comparable(
                quote_no=quote.quote_no,
                part_no=quote.part_no,
                customer=quote.customer,
                qty=quote.qty,
                price=quote.price,
                unit_price=round(quote.price / quote.qty, 2) if quote.price else None,
                status=quote.status,
                quoted_at=quote.quoted_at,
                lead_time_days=quote.lead_time_days,
                margin_pct=round(margin, 4) if margin is not None else None,
                margin_basis=basis,
                score=round(min(score, 1.0), 3),
                reasons=reasons,
            )
        )
    found.sort(key=lambda c: (-c.score, -c.quoted_at.toordinal(), c.quote_no))
    return found[:MAX_COMPARABLES]
