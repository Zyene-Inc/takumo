"""Lever costs: what an order costs, and what overtime adds."""

from datetime import date

from app.models import (
    CostBreakdown,
    Order,
    Part,
    ScheduleRequest,
    ScheduleResponse,
    WorkCenter,
)

OVERTIME_FACTOR = 1.25


# Overtime costs this share of the machine rate on top of the normal rate.
OVERTIME_PREMIUM = 0.5


def _ops_for(response: ScheduleResponse, order_nos: set[str]):
    return [op for op in response.operations if op.order_no in order_nos]


def order_cost(order: Order, part: Part, response: ScheduleResponse, rates: dict[str, WorkCenter]) -> CostBreakdown:
    """Machine time at each machine's rate + material, from where the plan put it."""
    missing: list[str] = []
    machine = 0.0
    for op in _ops_for(response, {order.order_no}):
        rate = rates[op.work_center].hourly_rate
        if rate is None:
            missing.append(f"hourly rate for {op.work_center}")
            continue
        routing = next(r for r in part.routing if r.seq == op.seq)
        # Clock time: standard minutes ÷ efficiency, as in quotes (app/quote).
        machine += routing.duration(order.qty) / rates[op.work_center].efficiency / 60 * rate
    material = None
    if part.material_cost is None:
        missing.append(f"material cost for {part.part_no}")
    else:
        material = part.material_cost * order.qty
    total = None if missing else round(machine + (material or 0), 2)
    price = order.price
    margin = round(price - total, 2) if price is not None and total is not None else None
    return CostBreakdown(
        machine=round(machine, 2) if not any("rate" in m for m in missing) else None,
        material=round(material, 2) if material is not None else None,
        total=total,
        price=price,
        margin=margin,
        margin_pct=round(margin / price * 100, 1) if margin is not None and price else None,
        missing=missing,
    )


def with_overtime(request: ScheduleRequest, machines: set[str]) -> ScheduleRequest:
    """More hours on the given machines only (working days and extra shifts)."""

    def longer(wc: WorkCenter) -> WorkCenter:
        if wc.name not in machines:
            return wc
        return wc.model_copy(
            update={
                "hours_per_day": min(24.0, wc.hours_per_day * OVERTIME_FACTOR),
                "exceptions": [
                    e.model_copy(update={"hours": min(24.0, e.hours * OVERTIME_FACTOR)}) for e in wc.exceptions
                ],
            }
        )

    return request.model_copy(update={"work_centers": [longer(wc) for wc in request.work_centers]})


def overtime_hours(overtime: ScheduleResponse, request: ScheduleRequest, until: date) -> dict[str, float]:
    """Clock hours above normal capacity, per machine, in the overtime plan, up to
    the day the new order finishes (overtime after that isn't needed for it)."""
    wcs = {wc.name: wc for wc in request.work_centers}
    extra: dict[str, float] = {}
    for day in overtime.load:
        if day.date > until:
            continue
        normal = round(
            wcs[day.work_center].hours_on(day.date) * 60 * wcs[day.work_center].efficiency * request.capacity_factor
        )
        over = day.load_minutes - normal
        if over > 0:
            hours = over / 60 / (wcs[day.work_center].efficiency * request.capacity_factor)
            extra[day.work_center] = extra.get(day.work_center, 0) + hours
    return {name: round(h, 1) for name, h in extra.items() if h >= 0.1}
