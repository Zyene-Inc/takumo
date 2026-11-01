"use client";

import type { UIMessage } from "@repo/ai";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { useMemo, useRef } from "react";
import {
  type ContextUse,
  conversationContext,
  LONG_CONTEXT,
  modelInfo,
  SETUP_TOKENS,
} from "@/lib/agent/history";

const SIZE = 16;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// The window to assume when an old answer didn't record its model.
const DEFAULT_WINDOW = 1_048_576;
// A sliver stays visible even when a million-token window is barely used.
const MIN_ARC = 0.04;

type Context = ContextUse & { estimated: boolean };

const short = (tokens: number) => {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_048_576).toFixed(1))}M`;
  }
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);
};

const percent = (share: number) =>
  share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;

/**
 * The conversation's context as the model last saw it. Updated when an
 * answer finishes, not on every streamed token.
 */
export const useConversationContext = (
  messages: UIMessage[],
  busy: boolean
) => {
  const settled = useMemo(
    () => (busy ? undefined : conversationContext(messages)),
    [busy, messages]
  );
  const last = useRef<Context | null>(null);
  if (settled !== undefined) {
    last.current = settled;
  }
  return last.current;
};

/** How much of the model's context window the conversation uses. */
export const ContextRing = ({ context }: { context: Context | null }) => {
  if (!context) {
    return null;
  }
  const model = modelInfo(context.model);
  const window = model?.window ?? DEFAULT_WINDOW;
  const share = Math.min(1, context.tokens / window);
  const long = context.tokens >= LONG_CONTEXT;
  const about = context.estimated ? "about " : "";
  const conversation = Math.max(0, context.tokens - SETUP_TOKENS);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={`Context: ${percent(share)} of the model's window`}
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
            <circle
              className={cn(
                "transition-[stroke-dashoffset] duration-500 ease-out",
                long && "stroke-amber-500"
              )}
              cx={SIZE / 2}
              cy={SIZE / 2}
              fill="none"
              r={RADIUS}
              stroke={long ? undefined : "url(#context-ring)"}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - Math.max(MIN_ARC, share))}
              strokeLinecap="round"
              strokeWidth={STROKE}
            />
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent className="grid max-w-64 gap-0.5 text-center">
        <p className="font-medium">
          Context: {about}
          {short(context.tokens)} of {short(window)} tokens ({percent(share)})
        </p>
        <p className="opacity-80">
          Your conversation {about}
          {short(conversation)} · Takumo's instructions and tools about{" "}
          {short(SETUP_TOKENS)}
        </p>
        {long && (
          <p className="opacity-80">
            Long conversation: a new chat answers faster and costs less.
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
};
