import "server-only";

import { log } from "@repo/observability/log";
import { DocumentExistsError } from "./documents";
import type { IngestEvent } from "./ingest";

// Our own messages are written for people; others can name the AI provider,
// so they get a plain one.
const errorText = (error: unknown) => {
  if (error instanceof DocumentExistsError) {
    return error.message;
  }
  return error instanceof Error && error.message.startsWith("No text found")
    ? error.message
    : "Couldn't read that file. Try again, or upload it as a PDF.";
};

/**
 * Run a document step by step and stream each step as newline-delimited
 * JSON: "step" events as stages finish, then "done" or "error".
 */
export const streamSteps = (
  run: (emit: (event: IngestEvent) => void) => Promise<unknown>
) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: IngestEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        await run(emit);
      } catch (error) {
        log.warn("Reading a document failed", { error: String(error) });
        emit({ type: "error", error: errorText(error) });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
