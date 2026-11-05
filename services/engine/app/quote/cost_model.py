"""Cost build-up and price for a quote.

cost = machine time × rate  +  material & other costs  +  outside processing

- Machine time is the routing's setup plus run time for the quantity, at the
  machine's efficiency (a 90%-efficient machine takes longer than standard),
  at its hourly rate.
- Material & other costs are calibrated from history: what past jobs for the
  same part *actually* cost, minus their machine time, per part. Without
  history, the estimator's stated stock usage, or other parts in the same
  material, in that order.
- Price = cost ÷ (1 − target margin). The target is the margin the shop
  actually made on won quotes (this customer's when there are two or more),
  and the range is the spread of those margins.
"""

import statistics
from dataclasses import dataclass, field

from app.models import (
    CostLine,
    HistoryPart,
    MarginPolicy,
    Operation,
    PastQuote,
    QuoteSpec,
    WorkCenter,
)
from app.quote.comparables import margin_of


def money(value: float) -> str:
    return f"${value:,.2f}"


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def machine_minutes(op: Operation, qty: int, wc: WorkCenter) -> float:
    """Clock minutes on the machine: standard time ÷ efficiency."""
    return (op.setup_min + op.run_min_per_unit * qty) / wc.efficiency


def machine_cost(
    routing: list[Operation], qty: int, wcs: dict[str, WorkCenter]
) -> float | None:
    total = 0.0
    for op in routing:
        wc = wcs.get(op.work_center)
        if wc is None or wc.hourly_rate is None:
            return None
        total += machine_minutes(op, qty, wc) / 60 * wc.hourly_rate
    return total


def machine_lines(
    spec: QuoteSpec, qty: int, wcs: dict[str, WorkCenter]
) -> tuple[list[CostLine], list[str]]:
    lines: list[CostLine] = []
    missing: list[str] = []
    for op in sorted(spec.routing, key=lambda o: o.seq):
        wc = wcs.get(op.work_center)
        if wc is None:
            missing.append(f"work center {op.work_center} (op {op.seq}) isn't in the shop")
            continue
        minutes = machine_minutes(op, qty, wc)
        hours = minutes / 60
        effic = f" ÷ {wc.efficiency * 100:.0f}% efficiency" if wc.efficiency != 1 else ""
        times = (
            f"{op.setup_min:g} min setup + {op.run_min_per_unit:g} min/ea × {qty:,}{effic}"
            f" = {hours:.1f} h"
        )
        if op.source == "actuals":
            times += " (average of jobs actually run)"
        elif op.source == "comparable":
            times += " (estimated from a similar part" + (f": {op.note}" if op.note else "") + ")"
        elif op.source == "estimator":
            times += " (entered by the estimator)"
        sources = [f"routing {spec.part_no} op {op.seq}"] if op.source in ("routing", "actuals") else []
        if wc.hourly_rate is None:
            missing.append(f"hourly rate for {op.work_center}")
            amount = None
            basis = times
        else:
            amount = round(hours * wc.hourly_rate, 2)
            basis = f"{times} × {money(wc.hourly_rate)}/h"
        lines.append(
            CostLine(
                kind="machine",
                label=f"Op {op.seq} · {op.work_center}",
                amount=amount,
                basis=basis,
                sources=[*sources, f"machine {op.work_center}"],
            )
        )
    return lines, missing


@dataclass
class OtherCost:
    """Material & other costs per finished part, and where the number came from."""

    per_unit: float | None
    label: str
    basis: str
    sources: list[str] = field(default_factory=list)
    warning: str | None = None


def _residuals(
    quotes: list[PastQuote],
    parts: dict[str, HistoryPart],
    wcs: dict[str, WorkCenter],
    cost_of,
) -> list[tuple[PastQuote, float]]:
    """(quote, cost per part beyond machine time) for quotes we can work it out for."""
    found = []
    for quote in quotes:
        cost = cost_of(quote)
        part = parts.get(quote.part_no or "")
        if cost is None or part is None or not part.routing:
            continue
        machine = machine_cost(part.routing, quote.qty, wcs)
        if machine is None:
            continue
        residual = (cost - machine) / quote.qty
        if residual >= 0:
            found.append((quote, residual))
    return found


def _names(found: list[tuple[PastQuote, float]]) -> str:
    names = [q.quote_no for q, _ in found]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + f" and {names[-1]}"


def other_cost(
    spec: QuoteSpec,
    history: list[PastQuote],
    parts: dict[str, HistoryPart],
    wcs: dict[str, WorkCenter],
) -> OtherCost:
    material = spec.material
    if material and material.usage_per_part and material.unit_cost is not None:
        per_unit = material.usage_per_part * material.unit_cost
        if material.unit == "ea" and material.usage_per_part == 1:
            return OtherCost(
                per_unit=per_unit,
                label="Material",
                basis=f"{money(per_unit)} per part ({material.name}), as stated",
                sources=[],
            )
        return OtherCost(
            per_unit=per_unit,
            label="Material",
            basis=(
                f"{material.usage_per_part:g} {material.unit} of {material.name} per part"
                f" × {money(material.unit_cost)}/{material.unit}"
            ),
            sources=[f"material {material.name}"],
        )

    same_part = [q for q in history if q.part_no == spec.part_no]
    found = _residuals(same_part, parts, wcs, lambda q: q.actual_cost)
    if found:
        value = statistics.median(r for _, r in found)
        return OtherCost(
            per_unit=value,
            label="Material & other costs",
            basis=(
                f"{money(value)}/ea: what {_names(found)} actually cost, less machine time"
                + (" (median)" if len(found) > 1 else "")
            ),
            sources=[f"quote {q.quote_no}" for q, _ in found],
        )

    found = _residuals(same_part, parts, wcs, lambda q: q.est_cost)
    if found:
        value = statistics.median(r for _, r in found)
        return OtherCost(
            per_unit=value,
            label="Material & other costs",
            basis=(
                f"{money(value)}/ea: the estimated cost of {_names(found)}, less machine time"
                " (no actual cost recorded)"
            ),
            sources=[f"quote {q.quote_no}" for q, _ in found],
            warning=(
                f"Material and other costs for {spec.part_no} come from past estimates, "
                "not actual costs."
            ),
        )

    if material:
        same_material = [
            q
            for q in history
            if q.part_no != spec.part_no
            and (parts.get(q.part_no or "") or HistoryPart(part_no="")).material == material.name
        ]
        found = _residuals(same_material, parts, wcs, lambda q: q.actual_cost)
        if found:
            value = statistics.median(r for _, r in found)
            others = sorted({q.part_no for q, _ in found if q.part_no})
            return OtherCost(
                per_unit=value,
                label="Material & other costs",
                basis=(
                    f"{money(value)}/ea: what other {material.name} parts "
                    f"({', '.join(others)}) actually cost, less machine time"
                ),
                sources=[f"quote {q.quote_no}" for q, _ in found],
                warning=(
                    f"No cost history for {spec.part_no}: material and other costs are taken "
                    f"from other {material.name} parts. Check the stock size, or enter the "
                    "stock used per part."
                ),
            )
        if material.unit == "ea" and material.unit_cost is not None:
            return OtherCost(
                per_unit=material.unit_cost,
                label="Material",
                basis=f"{money(material.unit_cost)} per part ({material.name})",
                sources=[f"material {material.name}"],
            )

    return OtherCost(
        per_unit=None,
        label="Material",
        basis="No cost history for this part and no stock usage given.",
    )


def _quantile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


# The highest margin a price is built on: cost / (1 - margin) runs away near 1.
MAX_MARGIN = 0.9


def margin_policy(spec: QuoteSpec, history: list[PastQuote]) -> MarginPolicy:
    won = [q for q in history if q.status == "won" and q.price]
    # A recorded cost of zero is missing data, not a 100% margin.
    actual = [
        (q, min((q.price - q.actual_cost) / q.price, MAX_MARGIN))
        for q in won
        if q.actual_cost is not None and q.actual_cost > 0
    ]
    pool, basis = actual, "actual"
    if not pool:
        pool = [
            (q, min(m, MAX_MARGIN))
            for q in won
            if (m := margin_of(q)[0]) is not None and m < 1
        ]
        basis = "quoted"
    for_customer = [(q, m) for q, m in pool if spec.customer and q.customer == spec.customer]
    if len(for_customer) >= 2:
        pool = for_customer
        whose = f"{spec.customer}'" if spec.customer.endswith("s") else f"{spec.customer}'s"
    else:
        whose = "the shop's"

    if not pool:
        if spec.target_margin is None and spec.default_margin is not None:
            return MarginPolicy(
                target=spec.default_margin,
                low=spec.default_margin,
                high=spec.default_margin,
                basis=(
                    f"Shop default margin {pct(spec.default_margin)}: "
                    "no won quotes with a known cost yet."
                ),
            )
        if spec.target_margin is None:
            return MarginPolicy(
                target=None,
                low=None,
                high=None,
                basis="No won quotes with a known cost yet: enter a target margin.",
            )
        return MarginPolicy(
            target=spec.target_margin,
            low=spec.target_margin,
            high=spec.target_margin,
            basis=f"Target margin {pct(spec.target_margin)}, entered by the estimator.",
        )

    margins = [m for _, m in pool]
    low, high = (
        (_quantile(margins, 0.25), _quantile(margins, 0.75))
        if len(margins) >= 3
        else (min(margins), max(margins))
    )
    median = statistics.median(margins)
    described = (
        f"Median {basis} margin on {whose} {len(pool)} won quote{'s' if len(pool) != 1 else ''}"
        f": {pct(median)} (range {pct(low)}–{pct(high)})"
    )
    if spec.target_margin is not None:
        return MarginPolicy(
            target=spec.target_margin,
            low=min(low, spec.target_margin),
            high=max(high, spec.target_margin),
            basis=f"Target margin {pct(spec.target_margin)}, entered by the estimator. {described}.",
            sources=[f"quote {q.quote_no}" for q, _ in pool],
        )
    return MarginPolicy(
        target=median,
        low=low,
        high=high,
        basis=f"{described}.",
        sources=[f"quote {q.quote_no}" for q, _ in pool],
    )


def price_at(cost: float, margin: float, qty: int) -> tuple[float, float]:
    """(unit price, total) at a margin; the unit price is rounded to the cent."""
    unit = round(cost / (1 - min(margin, MAX_MARGIN)) / qty, 2)
    return unit, round(unit * qty, 2)
