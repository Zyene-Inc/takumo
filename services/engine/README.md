# Engine

The Python service that does Takumo's maths: production schedules, "can we take this order?"
checks and quote estimates. The app sends it the shop as data and shows what it returns; the app
and the AI never compute schedules or prices themselves.

FastAPI + Google OR-Tools (CP-SAT). Deployed as a Docker image (`Dockerfile`, `deploy/`).

## Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /health` | `ok` (no secret needed) |
| `POST /schedule` | A plan: every operation on a machine and a time, late orders, and who runs each job |
| `POST /capacity` | The earliest date for a new order without delaying others, who slips if it goes first, and the levers (overtime, alternate machine, split lot) |
| `POST /quote` | Price per quantity break with a cost build-up, margin from won quotes, and lead time |

Every call except `/health` needs the `X-Engine-Secret` header to match `ENGINE_SECRET`.
Request and response shapes are in `app/models.py`, mirrored in `packages/engine-client`.

## Layout

```
app/main.py            Routes
app/models.py          Request and response models
app/scheduler/         CP-SAT model, dispatch fallback, calendars, staffing, operator assignment, capacity checks
app/quote/             Cost model, comparable past quotes, estimates
app/demo_shop.py       Loads seed/acme-precision for tests
tests/                 pytest suite, including random-shop plan validity checks
```

## Commands

```bash
uv sync
uv run uvicorn app.main:app --reload --port 8000   # or `pnpm dev:engine` from the repo root
uv run pytest -q                                    # or `pnpm test:engine`
uv run ruff check . && uv run ruff format --check .
```
