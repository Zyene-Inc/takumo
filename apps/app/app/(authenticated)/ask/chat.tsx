"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "@repo/ai";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowUpIcon,
  RotateCcwIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { collectSources, type Source } from "@/lib/agent/citations";
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

const SUGGESTIONS = [
  "Which orders are late or at risk right now?",
  "What's our quote win rate by customer?",
  "Which machine is the bottleneck over the next two weeks?",
  "Can we take 150 × P-1001 by next Friday?",
];

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

const AssistantMessage = ({
  message,
  registry,
  streaming,
}: {
  message: UIMessage;
  registry: ReadonlyMap<string, Source>;
  streaming: boolean;
}) => {
  // One footnote numbering across the whole answer.
  const { numbers, cited } = useMemo(() => {
    const texts = message.parts.flatMap((p) =>
      p.type === "text" ? [p.text] : []
    );
    const n = citationNumbers(texts, registry);
    return {
      numbers: n,
      cited: [...n.keys()]
        .map((id) => registry.get(id.toLowerCase()))
        .filter((s): s is Source => Boolean(s)),
    };
  }, [message.parts, registry]);

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
              text={part.text}
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
      {!streaming && <SourcesList numbers={numbers} sources={cited} />}
    </div>
  );
};

export const Chat = ({
  id,
  initialMessages,
  initialQuestion,
  isNew,
}: {
  id: string;
  initialMessages: UIMessage[];
  initialQuestion?: string;
  isNew: boolean;
}) => {
  const router = useRouter();
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  const { messages, sendMessage, status, stop, error, regenerate, clearError } =
    useChat({
      id,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: "/api/ask",
        prepareSendMessagesRequest: ({ id: chatId, messages: all }) => ({
          body: { id: chatId, message: all.at(-1), today: localToday() },
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-6">
          {messages.length === 0 && !initialQuestion && (
            <div className="grid gap-6 py-10 text-center">
              <div className="grid gap-2">
                <SparklesIcon className="mx-auto size-8 text-primary" />
                <h1 className="font-semibold text-2xl">Ask Takumo</h1>
                <p className="mx-auto max-w-md text-muted-foreground text-sm">
                  Questions about your orders, machines, quotes, schedule and
                  documents. Every number links to where it came from.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    className="rounded-xl border p-3 text-left text-sm transition-colors hover:bg-muted"
                    key={s}
                    onClick={() => send(s)}
                    type="button"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

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
                message={message}
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

      <form
        className="mx-auto w-full max-w-3xl px-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
          <Textarea
            aria-label="Ask Takumo"
            className="max-h-48 min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about orders, machines, quotes, the schedule or your documents…"
            rows={1}
            value={input}
          />
          {busy ? (
            <Button
              aria-label="Stop"
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
              disabled={!input.trim()}
              size="icon"
              type="submit"
            >
              <ArrowUpIcon />
            </Button>
          )}
        </div>
        <p className={cn("mt-1.5 text-center text-muted-foreground text-xs")}>
          Takumo answers from your shop's data and documents and cites every
          number. Check anything important before acting on it.
        </p>
      </form>
    </div>
  );
};
