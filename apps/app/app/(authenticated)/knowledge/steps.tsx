"use client";

import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, XIcon } from "lucide-react";
import { MAX_PART_BYTES, pieces } from "@/lib/quotes/upload-limits";
import { uploadKnowledgePart } from "./actions";

// Sending documents and following the steps the server streams back while
// it reads them. Shared by the Knowledge page and the Company Knowledge
// Library (uploads, new versions, reading again).

/** Why the server refused an upload, as it said (e.g. code "name_taken"). */
export interface Refusal {
  code?: string;
  existing?: { canAddVersion: boolean; id: string; name: string };
}

export interface FileLog {
  done: boolean;
  error: string | null;
  file: string;
  /** Set when the server refused the upload before reading it. */
  refusal?: Refusal;
  steps: string[];
}

export const kilobytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

type StepEvent =
  | { type: "step"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

/** What the server said when it refused an upload before reading it. */
const refused = async (
  response: Response
): Promise<Pick<FileLog, "error" | "refusal">> => {
  const body = (await response.json().catch(() => null)) as
    | ({ error?: string } & Refusal)
    | null;
  return {
    error: body?.error ?? "That didn't work. Try again.",
    ...(body?.code
      ? { refusal: { code: body.code, existing: body.existing } }
      : {}),
  };
};

/** Follow a document's steps as the server streams them. */
export const followSteps = async (
  send: () => Promise<Response>,
  log: FileLog,
  update: (log: FileLog) => void
) => {
  const show = () => update({ ...log, steps: [...log.steps] });
  show();
  try {
    const response = await send();
    if (!(response.ok && response.body)) {
      Object.assign(log, await refused(response));
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
export const sendPieces = async (
  file: File,
  url = "/api/knowledge/upload",
  fields: Record<string, string> = {}
) => {
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
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return fetch(url, { method: "POST", body: form });
};

/**
 * Send one file and follow its steps: to the Knowledge upload by default,
 * or another upload route (a new version) with extra form fields (a folder).
 */
export const uploadOne = (
  file: File,
  update: (log: FileLog) => void,
  { url = "/api/knowledge/upload", fields = {} } = {} as {
    fields?: Record<string, string>;
    url?: string;
  }
) => {
  const form = new FormData();
  form.set("file", file);
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return followSteps(
    () =>
      file.size > MAX_PART_BYTES
        ? sendPieces(file, url, fields)
        : fetch(url, { method: "POST", body: form }),
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
