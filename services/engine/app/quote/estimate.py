"""Quote estimate: cost build-up, suggested price and capacity-aware lead time
for each quantity, with the past quotes that back it up.

Lead time is the earliest the order could finish if it were booked today,
fitted around the current plan without making any open order later (the
same "fit" as the capacity check), starting no earlier than the material
arrives. All numbers come from here; the agent and the UI only show them.
"""

import math
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from app.models import (
    CostLine,
    Operation,
    Order,
    Part,
    QuoteBreak,
    QuoteRequest,
    QuoteResponse,
    ScheduleRequest,
)
from app.quote.comparables import find_comparables
from app.quote.cost_model import machine_lines, margin_policy, money, other_cost, pct, price_at
from app.scheduler.capacity import PARALLEL_WORKERS, SOLVED, _keep, _late
from app.scheduler.cpsat_model import order_result, solve_schedule

QUOTE_PART = "QUOTE {part_no}"
MAX_CHECKS = 3


def _outside_lines(request: QuoteRequest, qty: int) -> tuple[list[CostLine], list[str]]:
    lines, warnings = [], []
    for process in request.quote.outside:
        if process.cost_per_lot is None and process.cost_per_unit is None:
            warnings.append(f"Not priced yet: {process.description} (outside process).")
            continue
        lot, unit = process.cost_per_lot or 0.0, process.cost_per_unit or 0.0
        parts = []
        if lot:
            parts.append(f"{money(lot)} per lot")
        if unit:
            parts.append(f"{money(unit)}/ea × {qty:,}")
        lines.append(
            CostLine(
                kind="outside",
                label=process.description,
                amount=round(lot + unit * qty, 2),
                basis=" + ".join(parts) or "No charge",
            )
        )
    return lines, warnings


def _checks(response_breaks: list[QuoteBreak], comparables) -> list[str]:
    """How the suggested unit price compares with past quotes for the same part."""
    checks = []
    for comp in comparables:
        if "same part" not in comp.reasons or comp.unit_price is None:
            continue
        nearest = min(response_breaks, key=lambda b: abs(math.log(b.qty / comp.qty)))
        if nearest.unit_price is None:
            continue
        change = nearest.unit_price / comp.unit_price - 1
        direction = "above" if change > 0 else "below"
        size = f"{abs(change) * 100:.0f}% {direction}" if abs(change) >= 0.005 else "the same as"
        checks.append(
            f"At {nearest.qty:,}, {money(nearest.unit_price)}/ea is {size} "
            f"{comp.quote_no} ({comp.status}, {comp.qty:,} at {money(comp.unit_price)}/ea, "
            f"{comp.quoted_at:%b %-d, %Y})."
        )
        if len(checks) == MAX_CHECKS:
            break
    return checks


def _lead_times(request: QuoteRequest) -> tuple[str, dict[int, Order], dict, str | None]:
    """Schedule status, the order per quantity, results by quantity, and a note."""
    spec = request.quote
    material = spec.material
    release = None
    if material and material.lead_time_days:
        release = request.start_date + timedelta(days=material.lead_time_days)
    key = QUOTE_PART.format(part_no=spec.part_no)
    part = Part(
        part_no=key,
        routing=[Operation(**op.model_dump(include=set(Operation.model_fields))) for op in spec.routing],
    )
    base = ScheduleRequest(**request.model_dump(exclude={"quote", "history", "history_parts", "lead_times"}))
    base = base.model_copy(update={"parts": [*base.parts, part]})
    baseline = solve_schedule(base)
    if baseline.status not in SOLVED:
        return baseline.status, {}, {}, (
            "No lead time: the current plan can't be built "
            f"({'; '.join(c.message for c in baseline.conflicts) or baseline.status})."
        )
    caps = _late(baseline)
    keep = _keep(baseline, base)
    orders = {
        qty: Order(
            order_no=f"QUOTE-{qty}",
            part_no=key,
            qty=qty,
            # Due today, so the solver finishes it as early as it can.
            due_date=request.start_date,
            release_date=release,
        )
        for qty in spec.qty_breaks
    }
    with ThreadPoolExecutor(max_workers=len(orders)) as pool:
        futures = {
            qty: pool.submit(
                solve_schedule,
                base.model_copy(update={"orders": [*base.orders, order]}),
                lateness_caps=caps,
                keep=keep,
                num_workers=PARALLEL_WORKERS,
            )
            for qty, order in orders.items()
        }
        results = {qty: f.result() for qty, f in futures.items()}
    statuses = {r.status for r in results.values()}
    status = next((s for s in ("HEURISTIC", "FEASIBLE", "OPTIMAL") if s in statuses), "UNKNOWN")
    note = (
        "Lead time: calendar days from today to the earliest finish that doesn't make any "
        "open order later"
        + (
            f", with {material.name} in {material.lead_time_days} days (its lead time)"
            if release and material
            else ""
        )
        + "."
    )
    return status, orders, results, note


def estimate_quote(request: QuoteRequest) -> QuoteResponse:
    spec = request.quote
    if len(set(spec.qty_breaks)) != len(spec.qty_breaks) or any(q <= 0 for q in spec.qty_breaks):
        raise ValueError("Quantities must be positive and different")
    seqs = [op.seq for op in spec.routing]
    if len(set(seqs)) != len(seqs):
        raise ValueError("Operation numbers must be unique")
    wcs = {wc.name: wc for wc in request.work_centers}
    parts = {p.part_no: p for p in request.history_parts}

    other = other_cost(spec, request.history, parts, wcs)
    margin = margin_policy(spec, request.history)
    missing: list[str] = []
    warnings: list[str] = [other.warning] if other.warning else []
    if other.per_unit is None:
        missing.append(f"material cost per part for {spec.part_no}")
    if margin.target is None:
        missing.append("a target margin (no won quotes with a known cost)")

    breaks: list[QuoteBreak] = []
    for qty in sorted(spec.qty_breaks):
        lines, line_missing = machine_lines(spec, qty, wcs)
        lines.append(
            CostLine(
                kind="material",
                label=other.label,
                amount=None if other.per_unit is None else round(other.per_unit * qty, 2),
                basis=other.basis
                if other.per_unit is None
                else f"{money(other.per_unit)}/ea × {qty:,}. {other.basis}",
                sources=other.sources,
            )
        )
        outside, outside_warnings = _outside_lines(request, qty)
        lines.extend(outside)
        for item in [*line_missing, *outside_warnings]:
            target = missing if item in line_missing else warnings
            if item not in target:
                target.append(item)
        complete = not line_missing and other.per_unit is not None
        cost = round(sum(line.amount or 0 for line in lines), 2) if complete else None
        unit_price = price = low = high = margin_pct = None
        if cost is not None and margin.target is not None:
            unit_price, price = price_at(cost, margin.target, qty)
            low = price_at(cost, margin.low if margin.low is not None else margin.target, qty)[1]
            high = price_at(cost, margin.high if margin.high is not None else margin.target, qty)[1]
            margin_pct = round((price - cost) / price, 4) if price else None
        breaks.append(
            QuoteBreak(
                qty=qty,
                lines=lines,
                cost=cost,
                unit_cost=round(cost / qty, 2) if cost is not None else None,
                unit_price=unit_price,
                price=price,
                price_low=low,
                price_high=high,
                margin_pct=margin_pct,
            )
        )

    status, note = "PRICE_ONLY", None
    if request.lead_times and not any("isn't in the shop" in m for m in missing):
        status, orders, results, note = _lead_times(request)
        for row in breaks:
            result = results.get(row.qty)
            done = (
                order_result(result, orders[row.qty])
                if result is not None and result.status in SOLVED
                else None
            )
            if done:
                row.completion_date = done.completion_date
                row.lead_time_days = (done.completion_date - request.start_date).days
                if spec.requested_date:
                    row.meets_requested = done.completion_date <= spec.requested_date

    comparables = find_comparables(spec, request.history, parts, sorted(spec.qty_breaks)[0])
    checks = _checks(breaks, comparables)
    if margin.target is not None and margin.target < 0.1:
        warnings.append(f"The target margin is low ({pct(margin.target)}).")
    return QuoteResponse(
        status=status,
        breaks=breaks,
        comparables=comparables,
        margin=margin,
        checks=checks,
        missing=missing,
        warnings=warnings,
        lead_time_note=note,
    )
