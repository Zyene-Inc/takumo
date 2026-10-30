"""Request/response models shared by the API and the solvers.

Durations are in minutes, dates are calendar dates, clock times are local shop
time (no time zone). The web app maps its Prisma records (WorkCenter +
CalendarDay, Part + Routing, Order, pinned Job) into these shapes; keep
packages/engine-client/types.ts in sync.
"""

from datetime import date, datetime

from pydantic import BaseModel, Field

WEEKDAYS = [0, 1, 2, 3, 4]  # Monday = 0


class DayException(BaseModel):
    """A day a work center runs different hours: holiday (0), maintenance, Saturday shift."""

    date: date
    hours: float = Field(ge=0, le=24)
    reason: str | None = None


class WorkCenter(BaseModel):
    name: str
    hours_per_day: float = Field(gt=0, le=24, description="Hours on a normal working day")
    efficiency: float = Field(default=1.0, gt=0, le=1.5)
    working_days: list[int] = Field(
        default_factory=lambda: list(WEEKDAYS), description="Weekdays it runs, Monday = 0"
    )
    exceptions: list[DayException] = []
    hourly_rate: float | None = Field(default=None, ge=0)

    def hours_on(self, day: date) -> float:
        for exception in self.exceptions:
            if exception.date == day:
                return exception.hours
        return self.hours_per_day if day.weekday() in self.working_days else 0.0


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
    routing: list[Operation] = Field(min_length=1)
    material_cost: float | None = Field(
        default=None, ge=0, description="Material cost per finished part"
    )


class Order(BaseModel):
    order_no: str
    part_no: str
    qty: int = Field(gt=0)
    due_date: date
    priority: int = Field(default=0, ge=0, le=10)
    price: float | None = Field(default=None, ge=0)


class Pin(BaseModel):
    """A planner fixed this operation to a machine and a start day (dragged on the board)."""

    order_no: str
    seq: int
    work_center: str
    start_date: date


class ScheduleRequest(BaseModel):
    start_date: date
    work_centers: list[WorkCenter] = Field(min_length=1)
    parts: list[Part]
    orders: list[Order]
    pins: list[Pin] = []
    day_start: str = Field(default="07:00", pattern=r"^\d{2}:\d{2}$")
    capacity_factor: float = Field(
        default=1.0, gt=0, le=2, description="Multiply available hours, e.g. 1.25 = overtime"
    )
    time_limit_s: float = Field(default=10.0, gt=0, le=120)


class ScheduledOperation(BaseModel):
    order_no: str
    seq: int
    work_center: str
    start_date: date
    end_date: date
    start_at: datetime
    end_at: datetime
    minutes: int
    pinned: bool = False


class OrderResult(BaseModel):
    order_no: str
    due_date: date
    completion_date: date
    days_late: int


class DayLoad(BaseModel):
    work_center: str
    date: date
    load_minutes: int
    capacity_minutes: int


class Conflict(BaseModel):
    order_no: str
    seq: int | None = None
    message: str


class ScheduleResponse(BaseModel):
    # OPTIMAL | FEASIBLE: CP-SAT. HEURISTIC: CP-SAT found nothing in time, so this is
    # the dispatch-rule plan. INFEASIBLE: the pins can't all be honoured (see conflicts).
    status: str
    operations: list[ScheduledOperation] = []
    orders: list[OrderResult] = []
    load: list[DayLoad] = []
    conflicts: list[Conflict] = []
    total_days_late: int = 0


class CapacityRequest(ScheduleRequest):
    new_order: Order


class SlippedOrder(BaseModel):
    order_no: str
    days_late_before: int
    days_late_after: int


class Lever(BaseModel):
    kind: str  # "overtime" | "alternate_machine" | "split_lot"
    description: str
    on_time: bool
    completion_date: date | None = None
    extra_cost: float | None = None


class CostBreakdown(BaseModel):
    machine: float | None
    material: float | None
    total: float | None
    price: float | None
    margin: float | None
    margin_pct: float | None
    missing: list[str] = []  # what we couldn't price, e.g. "rate for DEBURR-1"


class CapacityResponse(BaseModel):
    status: str
    can_take: bool
    # The new order's earliest finish without moving any existing order.
    new_order: OrderResult | None = None
    # If the new order goes first instead: when it ships and who slips.
    rush: OrderResult | None = None
    slipped: list[SlippedOrder] = []
    levers: list[Lever] = []
    cost: CostBreakdown | None = None
    explanation: str
