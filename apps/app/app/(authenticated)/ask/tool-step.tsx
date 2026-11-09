"use client";

import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  CalculatorIcon,
  CalendarRangeIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  GaugeIcon,
  LightbulbIcon,
  type LucideIcon,
  SearchIcon,
  TableIcon,
} from "lucide-react";

const TOOL_LABEL: Record<
  string,
  { icon: LucideIcon; running: string; done: string }
> = {
  query_data: {
    icon: DatabaseIcon,
    running: "Querying your data",
    done: "Queried your data",
  },
  search_documents: {
    icon: SearchIcon,
    running: "Searching documents",
    done: "Searched documents",
  },
  get_record: {
    icon: BookOpenIcon,
    running: "Looking it up",
    done: "Looked up",
  },
  get_schedule: {
    icon: CalendarRangeIcon,
    running: "Reading the plan",
    done: "Read the plan",
  },
  check_capacity: {
    icon: GaugeIcon,
    running: "Running the scheduler",
    done: "Checked capacity",
  },
  run_scenario: {
    icon: FlaskConicalIcon,
    running: "Re-planning the scenario",
    done: "Ran a scenario",
  },
  estimate_quote: {
    icon: CalculatorIcon,
    running: "Pricing it",
    done: "Priced it",
  },
  propose_fact: {
    icon: LightbulbIcon,
    running: "Recording it for review",
    done: "Recorded for review",
  },
  show_artifact: {
    icon: TableIcon,
    running: "Building a view",
    done: "Built a view",
  },
};

export interface ToolPartView {
  errorText?: string;
  input?: unknown;
  output?: unknown;
  state: string;
  tool: string;
}

const CAPACITY_ANSWER: Record<string, string | undefined> = {
  true: "yes",
  false: "not as is",
};

const rowsLabel = (output: Record<string, unknown>) => {
  if (typeof output.row_count !== "number") {
    return undefined;
  }
  const plural = output.row_count === 1 ? "" : "s";
  return `${output.row_count} row${plural}${output.truncated ? "+" : ""}`;
};

const stepSummary = (part: ToolPartView) => {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const output = (part.output ?? {}) as Record<string, unknown>;
  switch (part.tool) {
    case "query_data":
      return [input.purpose as string | undefined, rowsLabel(output)];
    case "search_documents":
      return [
        input.query ? `“${input.query}”` : undefined,
        Array.isArray(output.results)
          ? `${output.results.length} matches`
          : undefined,
      ];
    case "get_record":
      return [
        input.type && input.key ? `${input.type} ${input.key}` : undefined,
      ];
    case "check_capacity":
      return [
        input.part_no
          ? `${input.qty} × ${input.part_no} by ${input.due_date}`
          : undefined,
        CAPACITY_ANSWER[String(output.can_take)],
      ];
    case "run_scenario":
      return [input.description as string | undefined];
    case "propose_fact":
      return [
        typeof output.fact === "string"
          ? `${output.fact}: ${output.about} · ${output.what} → ${output.proposed}`
          : undefined,
      ];
    case "estimate_quote":
      return [
        input.part_no && Array.isArray(input.qtys)
          ? `${input.qtys.join(" / ")} × ${input.part_no}`
          : undefined,
      ];
    default:
      return [];
  }
};

/** One tool call: what it did, expandable to the details. */
export const ToolStep = ({ part }: { part: ToolPartView }) => {
  const label = TOOL_LABEL[part.tool] ?? {
    icon: BookOpenIcon,
    running: part.tool,
    done: part.tool,
  };
  const running =
    part.state === "input-streaming" || part.state === "input-available";
  const output = (part.output ?? {}) as { error?: string };
  const failed = part.state === "output-error" || Boolean(output.error);
  const Icon = label.icon;
  const sql =
    part.tool === "query_data"
      ? (part.input as { sql?: string })?.sql
      : undefined;
  const summary = stepSummary(part).filter(Boolean).join(" · ");

  return (
    <details className="group text-muted-foreground text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
        {running ? <Spinner className="size-3" /> : <Icon className="size-3" />}
        <span className="font-medium">
          {running ? label.running : label.done}
        </span>
        {summary && <span className="truncate">· {summary}</span>}
        {failed && !running && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <AlertTriangleIcon className="size-3" /> retried
          </span>
        )}
      </summary>
      <div className="mt-1 ml-4.5 grid gap-1">
        {sql && (
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {sql}
          </pre>
        )}
        {(output.error || part.errorText) && (
          <p className="text-amber-700 dark:text-amber-400">
            {output.error ?? part.errorText}
          </p>
        )}
        {!sql && part.input !== undefined && (
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {JSON.stringify(part.input, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
};
