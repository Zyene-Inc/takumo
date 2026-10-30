import {
  collectSources,
  linkCitations,
  uncitedNumbers,
} from "@/lib/agent/citations";
import type { EvalContext, Golden } from "./golden";

const REGEX_CHARS = /[.*+?^${}()|[\]\\]/g;

const toRegex = (pattern: RegExp | string) =>
  typeof pattern === "string"
    ? new RegExp(pattern.replace(REGEX_CHARS, "\\$&"), "i")
    : new RegExp(pattern.source, `${pattern.flags.replace("i", "")}i`);

/** What grading needs from a generateText result. */
export interface AgentRun {
  steps: {
    toolCalls: { input: unknown; toolName: string }[];
    toolResults: { output: unknown }[];
  }[];
  text: string;
}

export interface Grade {
  calls: string[];
  cited: string[];
  failures: string[];
  uncitedLines: string[];
  unverified: string[];
}

/** Check one answer against its golden question. */
export const grade = (
  golden: Golden,
  result: AgentRun,
  ctx: EvalContext
): Grade => {
  const calls = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
  // Tables and charts are part of the answer the user sees.
  const shown = [
    result.text,
    ...result.steps
      .flatMap((s) => s.toolCalls)
      .filter((c) => c.toolName === "show_artifact")
      .map((c) => JSON.stringify(c.input)),
  ].join("\n");
  const outputs = result.steps.flatMap((s) =>
    s.toolResults.map((r) => r.output)
  );
  const { cited, unverified } = linkCitations(
    result.text,
    collectSources(outputs)
  );
  const uncitedLines = golden.noCitations ? [] : uncitedNumbers(result.text);

  const expected =
    typeof golden.expect === "function" ? golden.expect(ctx) : golden.expect;
  const failures = expected
    .map(toRegex)
    .filter((re) => !re.test(shown))
    .map((re) => `missing ${re}`);
  failures.push(
    ...(golden.forbid ?? [])
      .map(toRegex)
      .filter((re) => re.test(result.text))
      .map((re) => `shouldn't say ${re}`)
  );
  if (golden.tools && !golden.tools.some((t) => calls.includes(t))) {
    failures.push(
      `expected a call to ${golden.tools.join(" or ")}; used ${calls.join(", ") || "no tools"}`
    );
  }
  failures.push(
    ...(golden.forbidTools ?? [])
      .filter((t) => calls.includes(t))
      .map((t) => `shouldn't have called ${t}`)
  );
  if (!golden.noCitations && cited.length === 0) {
    failures.push("no verified citations");
  }
  if (unverified.length) {
    failures.push(`unverified citations: ${unverified.join(", ")}`);
  }
  if (uncitedLines.length) {
    failures.push(
      `numbers without a citation: ${uncitedLines.map((l) => `"${l.trim().slice(0, 80)}"`).join("; ")}`
    );
  }
  return {
    calls,
    cited: cited.map((c) => c.id),
    unverified,
    uncitedLines,
    failures,
  };
};
