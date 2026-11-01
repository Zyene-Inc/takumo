"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, Trash2Icon, UploadIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { DOCUMENT_TYPES } from "@/lib/knowledge/types";
import { deleteDocument } from "./actions";

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

/** Send one file and follow its steps as the server streams them. */
const uploadOne = async (file: File, update: (log: FileLog) => void) => {
  const log: FileLog = {
    file: file.name,
    steps: [`Uploading ${file.name} (${kilobytes(file.size)})`],
    done: false,
    error: null,
  };
  const show = () => update({ ...log, steps: [...log.steps] });
  show();
  const form = new FormData();
  form.set("file", file);
  try {
    const response = await fetch("/api/knowledge/upload", {
      method: "POST",
      body: form,
    });
    if (!(response.ok && response.body)) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      log.error = body?.error ?? "Upload failed. Try again.";
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
        const event = JSON.parse(line) as
          | { type: "step"; text: string }
          | { type: "done" }
          | { type: "error"; error: string };
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
      log.error = "The upload stopped before it finished. Try again.";
    }
  } catch {
    log.error = "Upload failed. Check your connection and try again.";
  }
  show();
};

const StepLog = ({ log }: { log: FileLog }) => (
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
