"""Capacity check: "Can we take this order?"

Solves the current plan with and without the new order, then reports
whether the new order is on time, which existing orders slip, and whether
overtime (+25% hours) would fix it. All numbers come from the solver;
the agent only explains them.
"""

from app.models import (
    CapacityRequest,
    CapacityResponse,
    Lever,
    ScheduleRequest,
    SlippedOrder,
)
from app.scheduler.cpsat_model import order_result, solve_schedule

OVERTIME_FACTOR = 1.25


def _late_by_order(response) -> dict[str, int]:
    return {r.order_no: r.days_late for r in response.orders}


def check_capacity(request: CapacityRequest) -> CapacityResponse:
    base_request = ScheduleRequest(**request.model_dump(exclude={"new_order"}))
    with_request = base_request.model_copy(
        update={"orders": [*request.orders, request.new_order]}
    )

    baseline = solve_schedule(base_request)
    with_new = solve_schedule(with_request)
    if with_new.status not in ("OPTIMAL", "FEASIBLE"):
        return CapacityResponse(
            status=with_new.status,
            can_take=False,
            explanation=f"The scheduler could not find a plan ({with_new.status}).",
        )

    before = _late_by_order(baseline)
    after = _late_by_order(with_new)
    slipped = [
        SlippedOrder(
            order_no=order_no,
            days_late_before=before.get(order_no, 0),
            days_late_after=late,
        )
        for order_no, late in after.items()
        if order_no != request.new_order.order_no and late > before.get(order_no, 0)
    ]
    new_result = order_result(with_new, request.new_order)
    can_take = bool(new_result and new_result.days_late == 0 and not slipped)

    levers: list[Lever] = []
    new_ops = [op for op in with_new.operations if op.order_no == request.new_order.order_no]
    part = next(p for p in request.parts if p.part_no == request.new_order.part_no)
    primary = {op.seq: op.work_center for op in part.routing}
    for op in new_ops:
        if op.work_center != primary.get(op.seq):
            levers.append(
                Lever(
                    kind="alternate_machine",
                    description=(
                        f"Run op {op.seq} on {op.work_center} instead of {primary.get(op.seq)}."
                    ),
                    on_time=new_result is not None and new_result.days_late == 0,
                )
            )

    if not can_take:
        overtime = solve_schedule(
            with_request.model_copy(
                update={"capacity_factor": request.capacity_factor * OVERTIME_FACTOR}
            )
        )
        overtime_after = _late_by_order(overtime)
        overtime_new = order_result(overtime, request.new_order)
        fixes_it = bool(
            overtime_new
            and overtime_new.days_late == 0
            and all(overtime_after.get(o, 0) <= before.get(o, 0) for o in before)
        )
        levers.append(
            Lever(
                kind="overtime",
                description=(
                    f"Add {round((OVERTIME_FACTOR - 1) * 100)}% more hours on all work "
                    "centers until the order ships."
                ),
                on_time=fixes_it,
            )
        )

    if can_take and new_result:
        explanation = (
            f"Yes. {request.new_order.order_no} finishes {new_result.completion_date} "
            f"(due {new_result.due_date}) and no existing order slips."
        )
    elif new_result:
        parts_of_answer = [
            f"Not as planned. {request.new_order.order_no} would finish "
            f"{new_result.completion_date} (due {new_result.due_date}, "
            f"{new_result.days_late} working days late)."
        ]
        if slipped:
            parts_of_answer.append(
                "It would push back: "
                + ", ".join(
                    f"{s.order_no} (+{s.days_late_after - s.days_late_before}d)"
                    for s in slipped
                )
                + "."
            )
        overtime_lever = next((lv for lv in levers if lv.kind == "overtime"), None)
        if overtime_lever and overtime_lever.on_time:
            parts_of_answer.append("Overtime would make it on time without slipping others.")
        explanation = " ".join(parts_of_answer)
    else:
        explanation = "No result for the new order."

    return CapacityResponse(
        status=with_new.status,
        can_take=can_take,
        new_order=new_result,
        slipped=slipped,
        levers=levers,
        explanation=explanation,
    )
