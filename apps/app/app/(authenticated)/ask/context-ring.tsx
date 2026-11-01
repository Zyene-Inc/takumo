"use client";

import type { UIMessage } from "@repo/ai";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { useMemo, useRef } from "react";
import { estimateContextTokens } from "@/lib/agent/history";

const SIZE = 16;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const NEARLY_FULL = 0.8;

const short = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);

/**
 * The context the next question starts with. Recounted when an answer
 * finishes, not on every streamed token.
 */
export const useContextTokens = (messages: UIMessage[], busy: boolean) => {
  const settled = useMemo(
    () => (busy ? null : estimateContextTokens(messages)),
    [busy, messages]
  );
  const last = useRef(0);
  if (settled !== null) {
    last.current = settled;
  }
  return last.current;
};

/** How full the conversation's context is, as a ring that closes. */
export const ContextRing = ({
  budget,
  tokens,
}: {
  budget: number;
  tokens: number;
}) => {
  if (tokens === 0) {
    return null;
  }
  const share = Math.min(1, tokens / budget);
  const full = share >= NEARLY_FULL;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`Context ${Math.round(share * 100)}% full`}
          className="grid size-7 place-items-center rounded-full hover:bg-muted"
          type="button"
        >
          <svg
            className="-rotate-90"
            height={SIZE}
            role="img"
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            width={SIZE}
          >
            <title>Context used</title>
            <defs>
              <linearGradient id="context-ring" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-2)" />
                <stop offset="100%" stopColor="var(--chart-1)" />
              </linearGradient>
            </defs>
            <circle
              className="stroke-muted-foreground/25"
              cx={SIZE / 2}
              cy={SIZE / 2}
              fill="none"
              r={RADIUS}
              strokeWidth={STROKE}
            />
            {share > 0 && (
              <circle
                className={cn(
                  "transition-[stroke-dashoffset] duration-500 ease-out",
                  full && "stroke-amber-500"
                )}
                cx={SIZE / 2}
                cy={SIZE / 2}
                fill="none"
                r={RADIUS}
                stroke={full ? undefined : "url(#context-ring)"}
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE * (1 - share)}
                strokeLinecap="round"
                strokeWidth={STROKE}
              />
            )}
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-60 text-center">
        <p className="font-medium">
          Context: {short(tokens)} of {short(budget)} tokens (
          {Math.round(share * 100)}%)
        </p>
        <p className="opacity-80">
          {full
            ? "Nearly full: start a new chat for a new topic."
            : "Older answers are kept short automatically."}
        </p>
      </TooltipContent>
    </Tooltip>
  );
};
