"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "@repo/ai";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  CalculatorIcon,
  CalendarRangeIcon,
  ClipboardCheckIcon,
  FactoryIcon,
  GaugeIcon,
  type LucideIcon,
  RotateCcwIcon,
  SparklesIcon,
  SquareIcon,
  ZapIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type AnswerMode, type AskMode, splitAnswer } from "@/lib/agent/answer";
import { collectSources, type Source } from "@/lib/agent/citations";
import {
  STARTER_LABEL,
  STARTER_TOPICS,
  type Starters,
  type StarterTopic,
} from "@/lib/agent/starters";
import type { Artifact } from "@/lib/agent/tools";
import { localToday } from "../schedule/gantt";
import {
  AnswerText,
  ArtifactView,
  citationNumbers,
  SourcesList,
  type ToolPartView,
  ToolStep,
} from "./message-parts";

const toolView = (part: UIMessage["parts"][number]): ToolPartView | null => {
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

const outputsOf = (messages: UIMessage[]) =>
  messages.flatMap((m) =>
    m.parts.map((p) => toolView(p)?.output).filter(Boolean)
  );

const TOPIC_ICON: Record<StarterTopic, LucideIcon> = {
  capacity: GaugeIcon,
  quotes: CalculatorIcon,
  schedule: CalendarRangeIcon,
  machines: FactoryIcon,
  setup: ClipboardCheckIcon,
};

const MODE_LABEL: Record<AskMode, string> = {
  auto: "Auto",
  quick: "Quick",
  thorough: "Thorough",
};

const MODE_HINT: Record<AskMode, string> = {
  auto: "Takumo picks: quick look-ups on the faster model, planning and pricing on the thorough one",
  quick: "Faster and cheaper, for look-ups, lists and simple counts",
  thorough: "The most capable model, for planning, pricing and what-ifs",
};

const AssistantMessage = ({
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

  return (
    <div className="grid gap-1">
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
          <p className="font-medium text-muted-foreground text-xs">Ask next</p>
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
  );
};

export const Chat = ({
  id,
  initialMessages,
  initialQuestion,
  isNew,
  starters,
}: {
  id: string;
  initialMessages: UIMessage[];
  initialQuestion?: string;
  isNew: boolean;
  /** Example questions by topic for the start screen; null in a conversation. */
  starters: Starters | null;
}) => {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<AskMode>("auto");
  const [topic, setTopic] = useState<StarterTopic | null>(null);
  // The transport reads the mode when it sends, so keep the latest in a ref.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const bottom = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  const { messages, sendMessage, status, stop, error, regenerate, clearError } =
    useChat({
      id,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: "/api/ask",
        prepareSendMessagesRequest: ({ id: chatId, messages: all, body }) => ({
          body: {
            id: chatId,
            message: all.at(-1),
            today: localToday(),
            mode:
              (body as { mode?: AskMode } | undefined)?.mode ?? modeRef.current,
          },
        }),
      }),
      onFinish: () => {
        // Keep the conversation in the URL and refresh the recent list.
        if (isNew) {
          router.replace(`/ask?c=${id}`, { scroll: false });
        }
        router.refresh();
      },
    });

  const busy = status === "submitted" || status === "streaming";
  const starting = messages.length === 0 && !initialQuestion;
  const registry = useMemo(
    () => collectSources(outputsOf(messages)),
    [messages]
  );

  const send = (text: string) => {
    const question = text.trim();
    if (!question || busy) {
      return;
    }
    clearError();
    sendMessage({ text: question });
    setInput("");
  };

  // ?q= from elsewhere in the app asks straight away.
  useEffect(() => {
    if (initialQuestion && !asked.current && messages.length === 0) {
      asked.current = true;
      sendMessage({ text: initialQuestion });
    }
  }, [initialQuestion, messages.length, sendMessage]);

  // Follow the answer as it streams in.
  const lastLength = JSON.stringify(messages.at(-1)?.parts ?? []).length;
  useEffect(() => {
    if (lastLength >= 0 && status) {
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [lastLength, status]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send(input);
    }
  };

  const errorText = (() => {
    if (!error) {
      return null;
    }
    try {
      return (
        (JSON.parse(error.message) as { error?: string }).error ?? error.message
      );
    } catch {
      return error.message;
    }
  })();

  const composer = (
    <form
      className="w-full"
      onSubmit={(e) => {
        e.preventDefault();
        send(input);
      }}
    >
      <div className="grid gap-1 rounded-2xl border bg-muted/40 p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
        <Textarea
          aria-label="Ask Takumo"
          autoFocus={starting}
          className="max-h-48 min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            starting
              ? "Ask about an order, a part, a machine or a quote…"
              : "Ask a follow-up…"
          }
          rows={starting ? 2 : 1}
          value={input}
        />
        <div className="flex items-center justify-between gap-2">
          <ToggleGroup
            aria-label="Answer mode"
            onValueChange={(v) => v && setMode(v as AskMode)}
            size="sm"
            type="single"
            value={mode}
            variant="outline"
          >
            {(Object.keys(MODE_LABEL) as AskMode[]).map((m) => (
              <ToggleGroupItem
                className="h-7 bg-background px-2.5 text-xs"
                key={m}
                title={MODE_HINT[m]}
                value={m}
              >
                {MODE_LABEL[m]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {busy ? (
            <Button
              aria-label="Stop"
              className="rounded-full"
              onClick={() => stop()}
              size="icon"
              type="button"
              variant="secondary"
            >
              <SquareIcon />
            </Button>
          ) : (
            <Button
              aria-label="Send"
              className="rounded-full"
              disabled={!input.trim()}
              size="icon"
              type="submit"
            >
              <ArrowUpIcon />
            </Button>
          )}
        </div>
      </div>
    </form>
  );

  if (starting) {
    const examples = topic && starters ? starters[topic] : [];
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 pt-[14vh] pb-10">
          <div className="grid justify-items-center gap-3 text-center">
            <span className="grid size-12 place-items-center rounded-full bg-foreground text-background">
              <SparklesIcon className="size-5" />
            </span>
            <h1 className="font-semibold text-2xl tracking-tight">
              What do you want to know about your shop?
            </h1>
          </div>
          {composer}
          {starters && (
            <div className="flex flex-wrap justify-center gap-2">
              {STARTER_TOPICS.map((t) => {
                const Icon = TOPIC_ICON[t];
                return (
                  <Button
                    aria-pressed={topic === t}
                    className={cn(
                      "rounded-full",
                      topic === t && "border-foreground bg-muted"
                    )}
                    key={t}
                    onClick={() => setTopic(topic === t ? null : t)}
                    size="sm"
                    variant="outline"
                  >
                    <Icon /> {STARTER_LABEL[t]}
                  </Button>
                );
              })}
            </div>
          )}
          {examples.length > 0 && (
            <ul className="grid gap-0.5">
              {examples.map((q) => (
                <li key={q}>
                  <button
                    className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => send(q)}
                    type="button"
                  >
                    <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                    {q}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {errorText && (
            <Alert variant="destructive">
              <AlertDescription>{errorText}</AlertDescription>
            </Alert>
          )}
          <p className="text-center text-muted-foreground text-xs">
            Answers come from your shop's data and documents, and every number
            links to where it came from.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-6">
          {messages.map((message, index) =>
            message.role === "user" ? (
              <div className="flex justify-end" key={message.id}>
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm">
                  {message.parts
                    .map((p) => (p.type === "text" ? p.text : ""))
                    .join("")}
                </div>
              </div>
            ) : (
              <AssistantMessage
                key={message.id}
                last={index === messages.length - 1}
                message={message}
                onAsk={send}
                onThorough={() => {
                  clearError();
                  regenerate({ body: { mode: "thorough" } });
                }}
                registry={registry}
                streaming={busy && index === messages.length - 1}
              />
            )
          )}

          {status === "submitted" && (
            <p className="flex items-center gap-2 text-muted-foreground text-sm">
              <span className="size-2 animate-pulse rounded-full bg-primary" />{" "}
              Thinking…
            </p>
          )}

          {errorText && (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {errorText}
                <Button
                  onClick={() => regenerate()}
                  size="sm"
                  variant="outline"
                >
                  <RotateCcwIcon /> Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div ref={bottom} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {composer}
        <p className="mt-1.5 text-center text-muted-foreground text-xs">
          Takumo cites every number. Check anything important before acting on
          it.
        </p>
      </div>
    </div>
  );
};
