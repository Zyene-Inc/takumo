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


class ShiftWindow(BaseModel):
    """Clock hours on given weekdays, e.g. Mon–Fri 15:30–24:00. An end at or
    before the start runs past midnight (counted on the day it starts)."""

    days: list[int] = Field(default_factory=lambda: list(WEEKDAYS))
    start: str = Field(pattern=r"^\d{2}:\d{2}$")
    end: str = Field(pattern=r"^\d{2}:\d{2}$")


class WorkCenter(BaseModel):
    name: str
    hours_per_day: float = Field(gt=0, le=24, description="Hours on a normal working day")
    efficiency: float = Field(default=1.0, gt=0, le=1.5)
    working_days: list[int] = Field(default_factory=lambda: list(WEEKDAYS), description="Weekdays it runs, Monday = 0")
    exceptions: list[DayException] = []
    hourly_rate: float | None = Field(default=None, ge=0)
    # When the machine runs, as clock windows. Empty: `hours_per_day` from the
    # plan's `day_start` on `working_days`. Used to match operators' shifts.
    shifts: list[ShiftWindow] = []
    # People needed per machine while it runs: 0.5 = one person runs two.
    operators_per_machine: float = Field(default=1.0, gt=0, le=4)
    # Runs need nobody once it's set up (lights-out), when an operator who
    # can leave machines running is in that day.
    unattended_runs: bool = False

    def hours_on(self, day: date) -> float:
        exception = self._exceptions_by_day().get(day)
        if exception is not None:
            return exception
        return self.hours_per_day if day.weekday() in self.working_days else 0.0

    def _exceptions_by_day(self) -> dict[date, float]:
        """Exceptions by date. Staffing adds one per short-staffed day for a
        year ahead, so a linear scan per day would dominate planning time.
        Cached against the list object itself: model_copy(update=...) with new
        exceptions gets a fresh list and so a fresh cache. The first exception
        for a date wins, as before."""
        cached = self.__dict__.get("_by_day_cache")
        if cached is not None and cached[0] is self.exceptions:
            return cached[1]
        by_day: dict[date, float] = {}
        for exception in self.exceptions:
            by_day.setdefault(exception.date, exception.hours)
        object.__setattr__(self, "_by_day_cache", (self.exceptions, by_day))
        return by_day


class Operator(BaseModel):
    """Someone who runs machines (F3.1). Their hours limit the machines'."""

    id: str
    name: str
    # Machines they're qualified to run (work center names).
    work_centers: list[str]
    shifts: list[ShiftWindow] = []
    # Can set up a machine and leave it running (lights-out, several machines).
    unattended: bool = False
    # Days they work different hours: vacation, sick (0), a short day.
    time_off: list[DayException] = []


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
    material_cost: float | None = Field(default=None, ge=0, description="Material cost per finished part")


class Order(BaseModel):
    order_no: str
    part_no: str
    qty: int = Field(gt=0)
    due_date: date
    priority: int = Field(default=0, ge=0, le=10)
    price: float | None = Field(default=None, ge=0)
    release_date: date | None = Field(
        default=None, description="No operation starts before this day (e.g. material arrives)"
    )
    # Where the material comes from, in words: "12 ft of 2 in 6061 on hand",
    # "arrives Thu Nov 12 on PO-4471" (F3.2-R4). Echoed in capacity answers.
    release_note: str | None = None


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
    # The shop's people (F3.3). Empty: machines' hours aren't limited by staff.
    operators: list[Operator] = []


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


class OperatorAssignment(BaseModel):
    """Who runs an operation, and when (F3.3 v2): one stretch of one person's
    time on one machine. An operation longer than a shift has several (day
    shift, then second shift); a lights-out machine has only its setup."""

    order_no: str
    seq: int
    work_center: str
    operator_id: str
    operator: str
    start_at: datetime
    end_at: datetime
    minutes: int
    # Only the setup: the machine then runs with nobody (unattended_runs).
    setup_only: bool = False


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
    # The machine's own hours that day (before staffing), in capacity minutes.
    # More than capacity_minutes: not enough qualified people on shift.
    machine_minutes: int | None = None


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
    # Plain-language notes about the plan's inputs, e.g. machines no operator
    # is listed for (their hours aren't checked against people).
    notices: list[str] = []
    # Who runs what, when (only with operators; machines nobody is listed
    # for have none).
    assignments: list[OperatorAssignment] = []


class CapacityRequest(ScheduleRequest):
    new_order: Order


class SlippedOrder(BaseModel):
    order_no: str
    days_late_before: int
    days_late_after: int


class Lever(BaseModel):
    # "overtime" | "alternate_machine" | "split_lot" | "extra_operator"
    # | "expedite_material"
    kind: str
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


# --- Quoting ---------------------------------------------------------------


class QuoteOperation(Operation):
    # Where the times come from: "routing" (the shop's routing), "actuals"
    # (average of jobs actually run), "comparable" (scaled from a similar
    # part's routing) or "estimator" (typed in by a person).
    source: str = "routing"
    note: str | None = None


class QuoteMaterial(BaseModel):
    name: str
    unit: str = "ea"
    unit_cost: float | None = Field(default=None, ge=0)
    lead_time_days: int | None = Field(default=None, ge=0)
    # Stock used per finished part, in `unit` (e.g. 0.4 ft of bar). Stated by
    # the estimator or the RFQ; overrides the cost calibrated from history.
    usage_per_part: float | None = Field(default=None, gt=0)


class OutsideProcess(BaseModel):
    """Work sent out (anodize, heat treat, plating). No cost = still to be priced."""

    description: str
    cost_per_lot: float | None = Field(default=None, ge=0)
    cost_per_unit: float | None = Field(default=None, ge=0)


class PastQuote(BaseModel):
    quote_no: str
    customer: str | None = None
    part_no: str | None = None
    qty: int = Field(gt=0)
    price: float | None = Field(default=None, ge=0)
    est_cost: float | None = Field(default=None, ge=0)
    actual_cost: float | None = Field(default=None, ge=0)
    status: str  # open | won | lost
    quoted_at: date
    lead_time_days: int | None = None


class HistoryPart(BaseModel):
    """A part from past quotes: its material and current routing."""

    part_no: str
    material: str | None = None
    routing: list[Operation] = []


class QuoteSpec(BaseModel):
    part_no: str
    customer: str | None = None
    material: QuoteMaterial | None = None
    routing: list[QuoteOperation] = Field(min_length=1)
    qty_breaks: list[int] = Field(min_length=1, max_length=6)
    outside: list[OutsideProcess] = []
    target_margin: float | None = Field(default=None, ge=0, lt=0.9)
    # The shop's margin for when it has no won quotes with a known cost yet.
    default_margin: float | None = Field(default=None, ge=0, lt=0.9)
    requested_date: date | None = None


class QuoteRequest(ScheduleRequest):
    """The shop as it is (for lead times) plus the part to quote and the quote history."""

    quote: QuoteSpec
    history: list[PastQuote] = []
    history_parts: list[HistoryPart] = []
    # False: price only (no lead times), e.g. while an estimator edits.
    lead_times: bool = True


class CostLine(BaseModel):
    kind: str  # machine | material | outside
    label: str
    amount: float | None
    basis: str
    sources: list[str] = []  # citable ids, e.g. "routing P-1001 op 10", "quote Q-9001"


class QuoteBreak(BaseModel):
    qty: int
    lines: list[CostLine]
    cost: float | None
    unit_cost: float | None
    unit_price: float | None
    price: float | None
    price_low: float | None
    price_high: float | None
    margin_pct: float | None
    completion_date: date | None = None
    lead_time_days: int | None = None
    meets_requested: bool | None = None


class Comparable(BaseModel):
    quote_no: str
    part_no: str | None
    customer: str | None
    qty: int
    price: float | None
    unit_price: float | None
    status: str
    quoted_at: date
    lead_time_days: int | None
    margin_pct: float | None
    margin_basis: str | None  # "actual" | "estimated"
    score: float
    reasons: list[str]


class MarginPolicy(BaseModel):
    target: float | None
    low: float | None
    high: float | None
    basis: str
    sources: list[str] = []


class QuoteResponse(BaseModel):
    status: str  # schedule status for lead times, or "PRICE_ONLY"
    breaks: list[QuoteBreak]
    comparables: list[Comparable]
    margin: MarginPolicy
    checks: list[str] = []  # price sanity checks against past quotes
    missing: list[str] = []  # what blocks a price (e.g. no hourly rate)
    warnings: list[str] = []  # priced, but someone should look (e.g. outside process unpriced)
    lead_time_note: str | None = None
