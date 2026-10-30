"""Takumo engine API. Called only server-side by apps/app (never the browser)."""

import hmac
import os

from fastapi import Depends, FastAPI, Header, HTTPException

from app.models import CapacityRequest, CapacityResponse, ScheduleRequest, ScheduleResponse
from app.scheduler.capacity import check_capacity
from app.scheduler.cpsat_model import solve_schedule

app = FastAPI(title="Takumo Engine", version="0.2.0")


def require_secret(x_engine_secret: str | None = Header(default=None)) -> None:
    expected = os.environ.get("ENGINE_SECRET")
    if expected and not hmac.compare_digest(x_engine_secret or "", expected):
        raise HTTPException(status_code=401, detail="Invalid engine secret")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/schedule", dependencies=[Depends(require_secret)])
def schedule(request: ScheduleRequest) -> ScheduleResponse:
    try:
        return solve_schedule(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/capacity", dependencies=[Depends(require_secret)])
def capacity(request: CapacityRequest) -> CapacityResponse:
    try:
        return check_capacity(request)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
