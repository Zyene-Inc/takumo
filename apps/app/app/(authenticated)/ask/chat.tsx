"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "@repo/ai";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  BrainIcon,
  CalculatorIcon,
  CalendarRangeIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  FactoryIcon,
  GaugeIcon,
  type LucideIcon,
  RotateCcwIcon,
  SparklesIcon,
  SquareIcon,
  ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AskMode } from "@/lib/agent/answer";
import { collectSources } from "@/lib/agent/citations";
import { isLongConversation } from "@/lib/agent/history";
import {
  STARTER_LABEL,
  STARTER_TOPICS,
  type Starters,
  type StarterTopic,
} from "@/lib/agent/starters";
import { localToday } from "../schedule/gantt";
import {
  AssistantMessage,
  outputsOf,
  Shimmer,
  THINKING_COLOR,
} from "./assistant-message";
import { ContextRing, useConversationContext } from "./context-ring";
import { DictateButton } from "./dictate";
import { TakumoEyes } from "./eyes";

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
  auto: "Takumo picks the right one for each question",
  quick: "Faster, for look-ups, lists and simple counts",
  thorough: "Most capable, for planning, pricing and what-ifs",
};

const MODE_ICON: Record<AskMode, LucideIcon> = {
  auto: SparklesIcon,
  quick: ZapIcon,
  thorough: BrainIcon,
};

/** The answer mode as a pill that opens a menu, next to Send. */
const ModeMenu = ({
  mode,
  onChange,
}: {
  mode: AskMode;
  onChange: (mode: AskMode) => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        aria-label={`Answer mode: ${MODE_LABEL[mode]}`}
        className="h-8 gap-1 rounded-full px-3 font-normal text-muted-foreground"
        size="sm"
        type="button"
        variant="ghost"
      >
        {MODE_LABEL[mode]}
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-72 rounded-xl p-1.5">
      {(Object.keys(MODE_LABEL) as AskMode[]).map((m) => {
        const Icon = MODE_ICON[m];
        return (
          <DropdownMenuItem
            className="items-start gap-3 rounded-lg px-2.5 py-2"
            key={m}
            onSelect={() => onChange(m)}
          >
            <Icon className="mt-0.5 size-4 text-muted-foreground" />
            <div className="grid flex-1 gap-0.5">
              <span className="font-medium">{MODE_LABEL[m]}</span>
              <span className="text-muted-foreground text-xs">
                {MODE_HINT[m]}
              </span>
            </div>
            {m === mode && <CheckIcon className="mt-0.5 size-4" />}
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuContent>
  </DropdownMenu>
);

export const Chat = ({
  canDictate,
  id,
  initialMessages,
  initialQuestion,
  isNew,
  starters,
}: {
  /** Whether speech-to-text is set up (the Dictate button). */
  canDictate: boolean;
  id: string;
  initialMessages: UIMessage[];
  initialQuestion?: string;
  isNew: boolean;
  /** Example questions by topic for the start screen; null in a conversation. */
  starters: Starters | null;
}) => {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [dictationError, setDictationError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
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
  const questions = messages.filter((m) => m.role === "user").length;
  const context = useConversationContext(messages, busy);
  const longConversation = isLongConversation(questions, context);
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
      {longConversation && (
        <p className="px-3 pb-1.5 text-muted-foreground text-xs">
          Long conversation: for a new topic,{" "}
          <Link className="underline underline-offset-2" href="/ask">
            start a new chat
          </Link>{" "}
          for faster, sharper answers.
        </p>
      )}
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
          ref={textarea}
          rows={starting ? 2 : 1}
          value={input}
        />
        <div className="flex items-center justify-end gap-1">
          <ContextRing context={context} />
          <ModeMenu mode={mode} onChange={setMode} />
          {canDictate && (
            <DictateButton
              disabled={busy}
              onError={setDictationError}
              onText={(text) => {
                setDictationError(null);
                setInput((prev) =>
                  prev.trim() ? `${prev.trimEnd()} ${text}` : text
                );
                textarea.current?.focus();
              }}
            />
          )}
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
      {dictationError && (
        <p className="px-3 pt-1.5 text-destructive text-xs" role="alert">
          {dictationError}
        </p>
      )}
    </form>
  );

  if (starting) {
    const examples = topic && starters ? starters[topic] : [];
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 pt-[14vh] pb-10">
          <div className="grid justify-items-center gap-3 text-center">
            <TakumoEyes
              className="size-16"
              glow
              mood={input.trim() ? "typing" : "idle"}
            />
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

          {/* Before the answer's own bubble (and avatar) appears. */}
          {busy && messages.at(-1)?.role === "user" && (
            <div className="flex items-center gap-3 text-sm">
              <TakumoEyes
                className={cn("size-7", THINKING_COLOR)}
                mood="thinking"
              />
              <Shimmer>Thinking…</Shimmer>
            </div>
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
