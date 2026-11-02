"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckIcon,
  RotateCwIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { DOCUMENT_TYPES } from "@/lib/knowledge/types";
import { MAX_PART_BYTES, pieces } from "@/lib/quotes/upload-limits";
import { deleteDocument, uploadKnowledgePart } from "./actions";

interface FileLog {
  done: boolean;
  error: string | null;
  file: string;
  steps: string[];
}

const kilobytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

type StepEvent =
  | { type: "step"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

/** Follow a document's steps as the server streams them. */
const followSteps = async (
  send: () => Promise<Response>,
  log: FileLog,
  update: (log: FileLog) => void
) => {
  const show = () => update({ ...log, steps: [...log.steps] });
  show();
  try {
    const response = await send();
    if (!(response.ok && response.body)) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      log.error = body?.error ?? "That didn't work. Try again.";
      return show();
    }
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line) as StepEvent;
        if (event.type === "step") {
          log.steps.push(event.text);
        } else if (event.type === "done") {
          log.done = true;
        } else {
          log.error = event.error;
        }
        show();
      }
    }
    if (!(log.done || log.error)) {
      log.error = "It stopped before it finished. Try again.";
    }
  } catch {
    log.error = "That didn't work. Check your connection and try again.";
  }
  show();
};

/** Large files go up in pieces first (each request is capped at 4.5 MB). */
const sendPieces = async (file: File) => {
  const uploadId = crypto.randomUUID();
  for (const [partIndex, [start, end]] of pieces(
    file.size,
    MAX_PART_BYTES
  ).entries()) {
    const form = new FormData();
    form.set("uploadId", uploadId);
    form.set("partIndex", String(partIndex));
    form.set("name", file.name);
    form.set("part", file.slice(start, end));
    const result = await uploadKnowledgePart(form);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400 });
    }
  }
  const form = new FormData();
  form.set("uploadId", uploadId);
  return fetch("/api/knowledge/upload", { method: "POST", body: form });
};

/** Send one file and follow its steps. */
const uploadOne = (file: File, update: (log: FileLog) => void) => {
  const form = new FormData();
  form.set("file", file);
  return followSteps(
    () =>
      file.size > MAX_PART_BYTES
        ? sendPieces(file)
        : fetch("/api/knowledge/upload", { method: "POST", body: form }),
    {
      file: file.name,
      steps: [`Uploading ${file.name} (${kilobytes(file.size)})`],
      done: false,
      error: null,
    },
    update
  );
};

export const StepLog = ({ log }: { log: FileLog }) => (
  <ol className="grid gap-1 rounded-lg border bg-muted/30 p-3 font-mono text-xs">
    {log.steps.map((step, i) => {
      const current = i === log.steps.length - 1 && !log.done && !log.error;
      return (
        <li
          className={cn(
            "flex items-start gap-2",
            current ? "text-foreground" : "text-muted-foreground"
          )}
          // biome-ignore lint/suspicious/noArrayIndexKey: steps only append
          key={i}
        >
          {current ? (
            <Spinner className="mt-px size-3 shrink-0" />
          ) : (
            <CheckIcon className="mt-px size-3 shrink-0 text-primary" />
          )}
          <span>{step}</span>
        </li>
      );
    })}
    {log.done && (
      <li className="flex items-center gap-2 font-medium text-foreground">
        <CheckIcon className="size-3 text-primary" /> Complete
      </li>
    )}
    {log.error && (
      <li className="flex items-start gap-2 text-destructive">
        <XIcon className="mt-px size-3 shrink-0" /> {log.error}
      </li>
    )}
  </ol>
);

export const UploadDocuments = () => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [logs, setLogs] = useState<FileLog[]>([]);

  const upload = async (files: FileList | null) => {
    if (!files?.length || busy) {
      return;
    }
    const chosen = Array.from(files);
    setBusy(true);
    setLogs([]);
    // One at a time, so each document's steps read in order.
    for (const [index, file] of chosen.entries()) {
      await uploadOne(file, (log) =>
        setLogs((prev) => {
          const next = [...prev];
          next[index] = log;
          return next;
        })
      );
    }
    if (input.current) {
      input.current.value = "";
    }
    setBusy(false);
    router.refresh();
  };

  return (
    <div className="grid gap-2">
      <button
        className={cn(
          "flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center transition-colors hover:bg-muted/50",
          over && "border-primary bg-primary/5"
        )}
        disabled={busy}
        onClick={() => input.current?.click()}
        onDragLeave={() => setOver(false)}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          upload(e.dataTransfer.files);
        }}
        type="button"
      >
        {busy ? (
          <Spinner className="size-5" />
        ) : (
          <UploadIcon className="size-5" />
        )}
        <span className="font-medium text-sm">
          {busy ? "Reading…" : "Drop documents here, or click to choose"}
        </span>
        <span className="text-muted-foreground text-xs">
          SOPs, setup sheets, quality manuals, customer specs, drawings. PDF
          (scanned too), Word, text, or photos of paper (JPG, PNG), up to 20 MB
          each. Takumo links them to your parts, machines and customers and
          proposes what they say as facts for review.
        </span>
      </button>
      <input
        accept={DOCUMENT_TYPES.join(",")}
        className="hidden"
        multiple
        onChange={(e) => upload(e.target.files)}
        ref={input}
        type="file"
      />
      {logs.filter(Boolean).map((log) => (
        <StepLog key={log.file} log={log} />
      ))}
    </div>
  );
};

/** Read a stored document again (understand, link, check), showing the steps. */
export const ReadAgain = ({ id, name }: { id: string; name: string }) => {
  const router = useRouter();
  const [log, setLog] = useState<FileLog | null>(null);
  const busy = Boolean(log && !log.done && !log.error);
  return (
    <>
      <Button
        aria-label={`Read ${name} again`}
        disabled={busy}
        onClick={async () => {
          await followSteps(
            () =>
              fetch("/api/knowledge/reread", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sourceId: id }),
              }),
            { file: name, steps: [], done: false, error: null },
            setLog
          );
          router.refresh();
        }}
        size="sm"
        title="Read it again: find the records it's about and propose its facts"
        variant="ghost"
      >
        {busy ? <Spinner /> : <RotateCwIcon />} Read again
      </Button>
      {log && (
        <div className="basis-full">
          <StepLog log={log} />
        </div>
      )}
    </>
  );
};

// biome-ignore lint/suspicious/noAlert: a plain confirm is enough here
const confirmRemove = (message: string) => window.confirm(message);

export const DeleteDocument = ({ id, name }: { id: string; name: string }) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      aria-label={`Remove ${name}`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          if (
            confirmRemove(
              `Remove "${name}"? Takumo won't be able to search it any more.`
            )
          ) {
            await deleteDocument(id);
            router.refresh();
          }
        })
      }
      size="icon"
      variant="ghost"
    >
      {pending ? <Spinner /> : <Trash2Icon />}
    </Button>
  );
};
