// @vitest-environment node
// The Ask route's stream pipeline (app/api/ask/route.ts) on a mock model:
// usage is recorded per step with the model's name, and the answer is still
// finished and saved when the browser goes away mid-answer. Guards the AI SDK
// upgrades, whose stream helpers and callbacks change between majors.
import {
  consumeStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  tool,
  toUIMessageStream,
  type UIMessage,
} from "@repo/ai";
import { MockLanguageModelV4 } from "@repo/ai/test";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

type Part = Record<string, unknown> & { type: string };

/** A stream that sends its parts slowly, like a model answering. */
const slow = (parts: Part[], delayMs: number) =>
  new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(part);
      }
      controller.close();
    },
  });

const head = (id: string): Part[] => [
  { type: "stream-start", warnings: [] },
  {
    type: "response-metadata",
    id,
    modelId: "mock-model",
    timestamp: new Date(0),
  },
];

/** Step 1 looks a part up; step 2 answers in many small pieces. */
const model = () => {
  let call = 0;
  return new MockLanguageModelV4({
    modelId: "mock-model",
    doStream: () => {
      call += 1;
      const parts: Part[] =
        call === 1
          ? [
              ...head("r1"),
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "lookup",
                input: JSON.stringify({ part: "BRK-2201" }),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_use" },
                usage: usage(100, 10),
              },
            ]
          : [
              ...head("r2"),
              { type: "text-start", id: "t" },
              ...Array.from({ length: 20 }, (_, i) => ({
                type: "text-delta",
                id: "t",
                delta: `word${i} `,
              })),
              { type: "text-end", id: "t" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "end_turn" },
                usage: usage(150, 40),
              },
            ];
      return Promise.resolve({ stream: slow(parts, 5) });
    },
  });
};

/** The route's pipeline, minus auth and the database. */
const ask = () => {
  const steps: { model: string; input: number }[] = [];
  let saved: UIMessage | null = null;
  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const tools = {
    lookup: tool({
      description: "Look a part up",
      inputSchema: z.object({ part: z.string() }),
      execute: ({ part }) => Promise.resolve({ part, onHand: 12 }),
    }),
  };
  const result = streamText({
    model: model(),
    instructions: "Answer the question.",
    tools,
    stopWhen: isStepCount(5),
    prompt: "How many BRK-2201 do we have?",
    onStepEnd: ({ usage: u, response }) => {
      steps.push({ model: response.modelId, input: u.inputTokens ?? 0 });
    },
  });
  result.consumeStream();
  const stream = toUIMessageStream({
    stream: result.stream,
    tools,
    originalMessages: [],
    generateMessageId: () => "answer-1",
    onEnd: ({ responseMessage }) => {
      saved = responseMessage;
      finished();
    },
  });
  return {
    done,
    response: createUIMessageStreamResponse({
      stream,
      consumeSseStream: consumeStream,
    }),
    saved: () => saved as UIMessage | null,
    steps,
  };
};

const textOf = (m: UIMessage | null) =>
  (m?.parts ?? [])
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();

describe("Ask's answer stream", () => {
  test("streams the answer and records usage for every step", async () => {
    const run = ask();
    const body = await run.response.text();
    await run.done;
    expect(body).toContain("word19");
    expect(run.steps).toEqual([
      { model: "mock-model", input: 100 },
      { model: "mock-model", input: 150 },
    ]);
    expect(textOf(run.saved())).toContain("word0 word1");
    expect(run.saved()?.parts.some((p) => p.type === "tool-lookup")).toBe(true);
  });

  test("still finishes and saves the answer when the browser goes away", async () => {
    const run = ask();
    const reader = run.response.body?.getReader();
    await reader?.read();
    // The user closes the tab after the first bytes.
    await reader?.cancel();
    await run.done;
    expect(textOf(run.saved())).toContain("word19");
    expect(run.steps).toHaveLength(2);
  });
});
