"use client";

import { ChevronRightIcon } from "lucide-react";
import type { Source } from "@/lib/agent/citations";
import { snippetRuns } from "@/lib/knowledge/chunk";
import { SourceName } from "./source-chips";

/** A document passage with the matched words highlighted. */
const Snippet = ({ text }: { text: string }) => (
  <p className="text-muted-foreground leading-relaxed">
    {snippetRuns(text).map((run) =>
      run.match ? (
        <mark
          className="rounded-sm bg-primary/15 px-0.5 text-foreground"
          key={run.start}
        >
          {run.text}
        </mark>
      ) : (
        run.text
      )
    )}
  </p>
);

/** Everything an answer cited, numbered like its footnotes. */
export const SourcesList = ({
  sources,
  numbers,
}: {
  numbers: ReadonlyMap<string, number>;
  sources: Source[];
}) =>
  sources.length === 0 ? null : (
    <details className="group text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
        {sources.length} source{sources.length === 1 ? "" : "s"}
      </summary>
      <ol className="mt-2 grid gap-2">
        {[...sources]
          .sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0))
          .map((s) => (
            <li className="flex gap-2" key={s.id}>
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1 font-medium text-muted-foreground">
                {numbers.get(s.id)}
              </span>
              <div className="grid min-w-0 gap-0.5">
                <SourceName source={s} />
                {s.detail && s.kind !== "doc" && (
                  <span className="text-muted-foreground">{s.detail}</span>
                )}
                {s.kind === "doc" && s.detail && <Snippet text={s.detail} />}
                {s.sql && (
                  <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px]">
                    {s.sql}
                  </pre>
                )}
              </div>
            </li>
          ))}
      </ol>
    </details>
  );
