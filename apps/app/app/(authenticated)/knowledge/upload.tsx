"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import { Trash2Icon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { DOCUMENT_TYPES } from "@/lib/knowledge/types";
import { deleteDocument, uploadDocument } from "./actions";

export const UploadDocuments = () => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [over, setOver] = useState(false);
  const [messages, setMessages] = useState<{ error: boolean; text: string }[]>(
    []
  );

  const upload = (files: FileList | null) => {
    if (!files?.length) {
      return;
    }
    start(async () => {
      const results: { error: boolean; text: string }[] = [];
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set("file", file);
        const r = await uploadDocument(form);
        results.push(
          r.ok
            ? {
                error: false,
                text: `${r.name}: ${r.chunks} passage${r.chunks === 1 ? "" : "s"} indexed.`,
              }
            : { error: true, text: `${file.name}: ${r.error}` }
        );
      }
      setMessages(results);
      if (input.current) {
        input.current.value = "";
      }
      router.refresh();
    });
  };

  return (
    <div className="grid gap-2">
      <button
        className={cn(
          "flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center transition-colors hover:bg-muted/50",
          over && "border-primary bg-primary/5"
        )}
        disabled={pending}
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
        {pending ? (
          <Spinner className="size-5" />
        ) : (
          <UploadIcon className="size-5" />
        )}
        <span className="font-medium text-sm">
          {pending ? "Reading…" : "Drop documents here, or click to choose"}
        </span>
        <span className="text-muted-foreground text-xs">
          SOPs, setup sheets, quality manuals, customer specs, notes. PDF, Word
          (.docx), text or Markdown, up to 20 MB each.
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
      {messages.map((m) => (
        <p
          className={cn("text-sm", m.error && "text-destructive")}
          key={m.text}
        >
          {m.text}
        </p>
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
