# Takumo engine (FastAPI + OR-Tools). Build from the repo root:
#   docker build -f services/engine/Dockerfile -t takumo-engine .
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

WORKDIR /app
COPY services/engine/pyproject.toml services/engine/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY services/engine/app ./app
# The demo shop loader reads the seed CSVs (tests and local demos only).
COPY seed/acme-precision /seed/acme-precision

EXPOSE 8000
CMD ["sh", "-c", "uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
