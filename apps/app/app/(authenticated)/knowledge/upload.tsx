"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import { RotateCwIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { DOCUMENT_TYPES } from "@/lib/knowledge/types";
import { deleteDocument } from "./actions";
import { type FileLog, followSteps, StepLog, uploadOne } from "./steps";

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
