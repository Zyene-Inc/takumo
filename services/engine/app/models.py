"""Request/response models shared by the API and the solvers.

Times are in minutes, dates are calendar dates. The web app maps its Prisma
records (WorkCenter, Part + Routing, Order) into these shapes.
"""

from datetime import date

from pydantic import BaseModel, Field


class WorkCenter(BaseModel):
    name: str
    hours_per_day: float = Field(gt=0, description="Available hours per working day")
    efficiency: float = Field(default=1.0, gt=0, le=1.5)

    @property
    def minutes_per_day(self) -> int:
        return max(1, round(self.hours_per_day * 60 * self.efficiency))


class Operation(BaseModel):
    seq: int
    work_center: str
    setup_min: float = Field(ge=0)
    run_min_per_unit: float = Field(ge=0)
    alt_work_centers: list[str] = []

    def duration(self, qty: int) -> int:
        return max(1, round(self.setup_min + self.run_min_per_unit * qty))


class Part(BaseModel):
    part_no: str
    routing: list[Operation]


class Order(BaseModel):
    order_no: str
    part_no: str
    qty: int = Field(gt=0)
    due_date: date
    priority: int = 0


class ScheduleRequest(BaseModel):
    start_date: date
    work_centers: list[WorkCenter]
    parts: list[Part]
    orders: list[Order]
    capacity_factor: float = Field(
        default=1.0, gt=0, description="Multiply available hours, e.g. 1.25 = overtime"
    )
    time_limit_s: float = Field(default=10.0, gt=0, le=120)


class ScheduledOperation(BaseModel):
    order_no: str
    seq: int
    work_center: str
    start_date: date
    end_date: date
    minutes: int


class OrderResult(BaseModel):
    order_no: str
    due_date: date
    completion_date: date
    days_late: int


class ScheduleResponse(BaseModel):
    status: str  # OPTIMAL | FEASIBLE | INFEASIBLE | UNKNOWN
    operations: list[ScheduledOperation] = []
    orders: list[OrderResult] = []
    total_days_late: int = 0


class CapacityRequest(ScheduleRequest):
    new_order: Order


class SlippedOrder(BaseModel):
    order_no: str
    days_late_before: int
    days_late_after: int


class Lever(BaseModel):
    kind: str  # "overtime" | "alternate_machine"
    description: str
    on_time: bool


class CapacityResponse(BaseModel):
    status: str
    can_take: bool
    new_order: OrderResult | None = None
    slipped: list[SlippedOrder] = []
    levers: list[Lever] = []
    explanation: str
