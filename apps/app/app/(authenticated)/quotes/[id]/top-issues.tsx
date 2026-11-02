"use client";

import { AlertTriangleIcon, HelpCircleIcon } from "lucide-react";
import type { TopIssue } from "@/lib/quotes/review";
import { useReviewFocus } from "./review-focus";

/**
 * What to check before sending, across every line, at the top of the screen
 * (F2.6-R1). Clicking a flag shows its spot on the line's drawing.
 */
export const TopIssues = ({
  flags,
  questions,
}: {
  flags: TopIssue[];
  questions: string[];
}) => {
  const { show } = useReviewFocus();
  if (flags.length === 0 && questions.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Check before sending"
      className="grid gap-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4 md:grid-cols-2 dark:border-amber-900 dark:bg-amber-950/20"
    >
      {flags.length > 0 && (
        <div className="grid content-start gap-1.5">
          <p className="font-medium text-sm">Check this ({flags.length})</p>
          <ul className="grid gap-1 text-sm">
            {flags.map(({ flag, lineId, lineLabel }) => (
              <li key={`${lineId}-${flag.kind}-${flag.message}`}>
                <button
                  className="flex w-full gap-2 rounded text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    show(
                      {
                        lineId,
                        sheet: flag.sheet,
                        box: flag.box,
                        label: flag.message,
                      },
                      { scroll: true }
                    )
                  }
                  type="button"
                >
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <span>
                    <span className="text-muted-foreground">{lineLabel}: </span>
                    {flag.message}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {questions.length > 0 && (
        <div className="grid content-start gap-1.5">
          <p className="font-medium text-sm">
            Questions for the customer ({questions.length})
          </p>
          <ul className="grid gap-1 text-sm">
            {questions.map((q) => (
              <li className="flex gap-2" key={q}>
                <HelpCircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                {q}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            These go in the draft reply.
          </p>
        </div>
      )}
    </section>
  );
};
