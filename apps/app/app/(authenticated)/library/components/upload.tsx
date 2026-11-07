"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import { UploadIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from "@/lib/knowledge/types";
import { retryVersion } from "../../knowledge/actions";
import { type FileLog, StepLog, uploadOne } from "../../knowledge/steps";

/** Refused in the browser before sending: the same rules the server applies. */
export const localProblem = (file: { name: string; size: number }) => {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!(DOCUMENT_TYPES as readonly string[]).includes(ext)) {
    return `Takumo reads ${DOCUMENT_TYPES.join(", ")} files.`;
  }
  if (file.size === 0) {
    return "That file is empty.";
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return "Files can be up to 20 MB.";
  }
  return null;
};

interface Entry {
  file: File;
  key: string;
  log: FileLog;
}

const fresh = (file: File, step: string): FileLog => ({
  file: file.name,
  steps: [step],
  done: false,
  error: null,
});

/** What to do about a name that's taken: open it, or add this as a new version. */
const NameTaken = ({
  entry,
  onNewVersion,
}: {
  entry: Entry;
  onNewVersion: (id: string) => void;
}) => {
  const existing = entry.log.refusal?.existing;
  if (!existing) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild size="sm" variant="outline">
        <Link href={`/library/d/${existing.id}`}>Open {existing.name}</Link>
      </Button>
      {existing.canAddVersion && (
        <Button onClick={() => onNewVersion(existing.id)} size="sm">
          Upload as a new version of {existing.name}
        </Button>
      )}
    </div>
  );
};

/**
 * Upload documents into a folder (or the top level). Closing the window
 * doesn't stop anything: the server keeps reading each document and the
 * list shows its status.
 */
export const LibraryUpload = ({
  folderId,
  folderName,
}: {
  folderId: string | null;
  folderName: string;
}) => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);

  const update = (index: number) => (log: FileLog) =>
    setEntries((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], log };
      return next;
    });

  const send = async (files: File[]) => {
    if (files.length === 0 || busy) {
      return;
    }
    setBusy(true);
    const start = entries.length;
    setEntries((prev) => [
      ...prev,
      ...files.map((file) => ({
        file,
        key: crypto.randomUUID(),
        log: fresh(file, `Waiting to upload ${file.name}`),
      })),
    ]);
    // One at a time, so each document's steps read in order.
    for (const [i, file] of files.entries()) {
      const problem = localProblem(file);
      if (problem) {
        update(start + i)({
          ...fresh(file, `Checking ${file.name}`),
          error: problem,
        });
        continue;
      }
      // Once the server has the file (its first step back), the document is
      // in the list: show it there, where its status keeps updating, even
      // if this window is closed.
      let listed = false;
      await uploadOne(
        file,
        (log) => {
          update(start + i)(log);
          if (!listed && log.steps.length > 1) {
            listed = true;
            router.refresh();
          }
        },
        { fields: folderId ? { folderId } : {} }
      );
    }
    if (input.current) {
      input.current.value = "";
    }
    setBusy(false);
    router.refresh();
  };

  const asNewVersion = async (index: number, sourceId: string) => {
    const { file } = entries[index];
    setBusy(true);
    await uploadOne(file, update(index), {
      url: `/api/library/documents/${sourceId}/versions`,
    });
    setBusy(false);
    toast.success(`Sent ${file.name} as a new version.`);
    router.refresh();
  };

  return (
    // The button is the dialog's trigger, so closing it returns focus there.
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm">{busy ? <Spinner /> : <UploadIcon />} Upload</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload to {folderName}</DialogTitle>
          <DialogDescription>
            PDF (scanned too), Word, text, CSV, or photos of paper (JPG, PNG,
            WebP), up to 20 MB each. You can close this window: Takumo keeps
            reading them, and their status shows in the list.
          </DialogDescription>
        </DialogHeader>
        <button
          className={cn(
            "flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
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
            send(Array.from(e.dataTransfer.files));
          }}
          type="button"
        >
          {busy ? (
            <Spinner className="size-5" />
          ) : (
            <UploadIcon className="size-5" />
          )}
          <span className="font-medium text-sm">
            {busy ? "Uploading…" : "Drop documents here, or click to choose"}
          </span>
        </button>
        <input
          accept={DOCUMENT_TYPES.join(",")}
          aria-label="Choose documents to upload"
          className="hidden"
          multiple
          onChange={(e) => send(Array.from(e.target.files ?? []))}
          ref={input}
          type="file"
        />
        <div aria-live="polite" className="grid gap-2">
          {entries.map((entry, index) => (
            <div className="grid gap-2" key={entry.key}>
              <StepLog log={entry.log} />
              {entry.log.refusal?.code === "name_taken" && (
                <NameTaken
                  entry={entry}
                  onNewVersion={(id) => asNewVersion(index, id)}
                />
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

/** Upload a file as the document's new version (needs edit on it). */
export const UploadNewVersion = ({
  name,
  sourceId,
}: {
  name: string;
  sourceId: string;
}) => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<FileLog | null>(null);
  const busy = Boolean(log && !log.done && !log.error);
  const send = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    const problem = localProblem(file);
    if (problem) {
      setLog({ ...fresh(file, `Checking ${file.name}`), error: problem });
      return;
    }
    await uploadOne(file, setLog, {
      url: `/api/library/documents/${sourceId}/versions`,
    });
    if (input.current) {
      input.current.value = "";
    }
    router.refresh();
  };
  return (
    <div className="grid gap-2">
      <div>
        <Button
          disabled={busy}
          onClick={() => input.current?.click()}
          size="sm"
          variant="outline"
        >
          {busy ? <Spinner /> : <UploadIcon />} Upload new version
        </Button>
        <input
          accept={DOCUMENT_TYPES.join(",")}
          aria-label={`Choose a new version of ${name}`}
          className="hidden"
          onChange={(e) => send(e.target.files?.[0])}
          ref={input}
          type="file"
        />
      </div>
      {log && <StepLog log={log} />}
      {log && !log.error && (
        <p className="text-muted-foreground text-xs">
          The current version stays in use until the new one is ready. If it
          fails, nothing changes.
        </p>
      )}
    </div>
  );
};

/** Try a failed version again. */
export const RetryVersion = ({
  sourceId,
  versionId,
}: {
  sourceId: string;
  versionId: string;
}) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const result = await retryVersion(sourceId, versionId);
        setBusy(false);
        if (result.ok) {
          toast.success("Takumo will read it again shortly.");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      }}
      size="sm"
      variant="outline"
    >
      {busy && <Spinner />} Retry
    </Button>
  );
};
