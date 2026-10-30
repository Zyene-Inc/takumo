import "server-only";

import { keys } from "./keys";
import type {
  CapacityRequest,
  CapacityResponse,
  QuoteRequest,
  QuoteResponse,
  ScheduleRequest,
  ScheduleResponse,
} from "./types";

export * from "./types";

// Solves stop early once they stall, but a capacity check runs two rounds.
const REQUEST_TIMEOUT_MS = 90_000;

/** The engine refused or failed a request. `detail` is safe to show (422s explain bad input). */
export class EngineError extends Error {
  readonly detail: string;
  readonly status: number;

  constructor(status: number, body: string) {
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { detail?: unknown };
      if (typeof parsed.detail === "string") {
        detail = parsed.detail;
      }
    } catch {
      // Not JSON: keep the raw body.
    }
    super(`Engine request failed (${status}): ${detail}`);
    this.name = "EngineError";
    this.status = status;
    this.detail = detail;
  }
}

const post = async <TResponse>(path: string, body: unknown) => {
  const { ENGINE_URL, ENGINE_SECRET } = keys();
  const response = await fetch(new URL(path, ENGINE_URL), {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      ...(ENGINE_SECRET ? { "X-Engine-Secret": ENGINE_SECRET } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new EngineError(response.status, await response.text());
  }

  return (await response.json()) as TResponse;
};

/** Solve a production schedule with the CP-SAT scheduler. */
export const schedule = (request: ScheduleRequest) =>
  post<ScheduleResponse>("/schedule", request);

/** "Can we take this order?": compares the plan with and without it. */
export const checkCapacity = (request: CapacityRequest) =>
  post<CapacityResponse>("/capacity", request);

/** Quote estimate: cost build-up, price and lead time for each quantity. */
export const estimateQuote = (request: QuoteRequest) =>
  post<QuoteResponse>("/quote", request);
