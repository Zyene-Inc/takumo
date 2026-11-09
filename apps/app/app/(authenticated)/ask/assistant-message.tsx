"use client";

// One answer from Ask Takumo: its text, tools used, sources and charts.

import type { UIMessage } from "@repo/ai";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowRightIcon, ZapIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type AnswerMode, splitAnswer } from "@/lib/agent/answer";
import type { Source } from "@/lib/agent/citations";
import type { Artifact } from "@/lib/agent/tools";
import { TakumoEyes, type TakumoMood } from "./eyes";
import {
  AnswerText,
  ArtifactView,
  citationNumbers,
  SourcesList,
  type ToolPartView,
  ToolStep,
} from "./message-parts";

export const toolView = (
  part: UIMessage["parts"][number]
): ToolPartView | null => {
  if (!part.type.startsWith("tool-")) {
    return null;
  }
  const p = part as {
    errorText?: string;
    input?: unknown;
    output?: unknown;
    state: string;
  };
  return {
    tool: part.type.slice(5),
    state: p.state,
    input: p.input,
    output: p.output,
    errorText: p.errorText,
  };
};

export const outputsOf = (messages: UIMessage[]) =>
  messages.flatMap((m) =>
    m.parts.map((p) => toolView(p)?.output).filter(Boolean)
  );

/** The gear is black while Takumo works (dark grey in dark mode). */
export const THINKING_COLOR = "text-slate-900 dark:text-slate-600";

/** Text with a light sweeping across it, for work in progress. */
export const Shimmer = ({ children }: { children: string }) => {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const sweep = el.current?.animate(
      [{ backgroundPosition: "100% 0" }, { backgroundPosition: "-100% 0" }],
      { duration: 1800, iterations: Number.POSITIVE_INFINITY }
    );
    return () => sweep?.cancel();
  }, []);
  return (
    <span
      className="bg-clip-text font-medium text-transparent"
      ref={el}
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%)",
        backgroundSize: "200% 100%",
      }}
    >
      {children}
    </span>
  );
};

export const AssistantMessage = ({
  message,
  registry,
  streaming,
  last,
  onAsk,
  onThorough,
}: {
  last: boolean;
  message: UIMessage;
  onAsk: (text: string) => void;
  onThorough: () => void;
  registry: ReadonlyMap<string, Source>;
  streaming: boolean;
}) => {
  // The answer without its option and follow-up blocks, which become buttons.
  const split = useMemo(
    () =>
      message.parts.map((p) =>
        p.type === "text" ? splitAnswer(p.text) : null
      ),
    [message.parts]
  );
  // One footnote numbering across the whole answer.
  const { numbers, cited } = useMemo(() => {
    const texts = split.flatMap((p) => (p ? [p.body] : []));
    const n = citationNumbers(texts, registry);
    return {
      numbers: n,
      cited: [...n.keys()]
        .map((id) => registry.get(id.toLowerCase()))
        .filter((s): s is Source => Boolean(s)),
    };
  }, [split, registry]);
  const options = split.flatMap((p) => p?.options ?? []);
  const followUps = split.flatMap((p) => p?.followUps ?? []);
  const mode = (message.metadata as { mode?: AnswerMode } | undefined)?.mode;
  const done = !streaming;
  // A smile for a moment when the answer lands.
  const [smiling, setSmiling] = useState(false);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      setSmiling(true);
      const t = window.setTimeout(() => setSmiling(false), 2200);
      wasStreaming.current = streaming;
      return () => window.clearTimeout(t);
    }
    wasStreaming.current = streaming;
  }, [streaming]);
  // Until the first words or tool step arrive, the avatar says it's thinking.
  const started = message.parts.some(
    (p, i) =>
      (p.type === "text" && Boolean(split[i]?.body.trim())) ||
      p.type.startsWith("tool-")
  );
  let face: TakumoMood = "idle";
  if (streaming) {
    face = "thinking";
  } else if (smiling) {
    face = "happy";
  }

  return (
    <div className="flex gap-3">
      <TakumoEyes
        className={cn("mt-0.5 size-7", streaming && THINKING_COLOR)}
        live={last}
        mood={face}
      />
      <div className="grid min-w-0 flex-1 gap-1">
        {streaming && !started && (
          <p className="flex h-7 items-center text-sm">
            <Shimmer>Thinking…</Shimmer>
          </p>
        )}
        {message.parts.map((part, i) => {
          const key = `${message.id}-${i}`;
          if (part.type === "text") {
            return (
              <AnswerText
                key={key}
                numbers={numbers}
                registry={registry}
                streaming={streaming && i === message.parts.length - 1}
                text={split[i]?.body ?? part.text}
              />
            );
          }
          const tool = toolView(part);
          if (!tool) {
            return null;
          }
          if (tool.tool === "show_artifact") {
            return tool.state === "output-available" &&
              !(tool.output as { error?: string })?.error ? (
              <ArtifactView artifact={tool.input as Artifact} key={key} />
            ) : null;
          }
          return <ToolStep key={key} part={tool} />;
        })}
        {done && last && options.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {options.map((o) => (
              <Button
                key={o}
                onClick={() => onAsk(o)}
                size="sm"
                variant="outline"
              >
                {o}
              </Button>
            ))}
          </div>
        )}
        {done && <SourcesList numbers={numbers} sources={cited} />}
        {done && last && followUps.length > 0 && (
          <div className="mt-3 grid gap-1 border-t pt-3">
            <p className="font-medium text-muted-foreground text-xs">
              Ask next
            </p>
            {followUps.map((q) => (
              <button
                className="group flex items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-muted"
                key={q}
                onClick={() => onAsk(q)}
                type="button"
              >
                <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                {q}
              </button>
            ))}
          </div>
        )}
        {done && last && mode === "quick" && (
          <p className="mt-2 flex items-center gap-1.5 text-muted-foreground text-xs">
            <ZapIcon className="size-3" /> Quick answer.
            <button
              className="underline underline-offset-2 hover:text-foreground"
              onClick={onThorough}
              type="button"
            >
              Answer thoroughly
            </button>
          </p>
        )}
      </div>
    </div>
  );
};
