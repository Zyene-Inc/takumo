import "server-only";

import { keys } from "./keys";
import type {
  CapacityRequest,
  CapacityResponse,
  ScheduleRequest,
  ScheduleResponse,
} from "./types";

export type * from "./types";

const post = async <TResponse>(path: string, body: unknown) => {
  const { ENGINE_URL, ENGINE_SECRET } = keys();
  const response = await fetch(new URL(path, ENGINE_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ENGINE_SECRET ? { "X-Engine-Secret": ENGINE_SECRET } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Engine ${path} failed (${response.status}): ${detail}`);
  }

  return (await response.json()) as TResponse;
};

/** Solve a production schedule with the CP-SAT scheduler. */
export const schedule = (request: ScheduleRequest) =>
  post<ScheduleResponse>("/schedule", request);

/** "Can we take this order?": compares the plan with and without it. */
export const checkCapacity = (request: CapacityRequest) =>
  post<CapacityResponse>("/capacity", request);
