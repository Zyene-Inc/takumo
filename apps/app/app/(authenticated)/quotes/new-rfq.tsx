"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import { FileTextIcon, PlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { PACKAGE_TYPES } from "@/lib/quotes/file-types";
import { DictateButton } from "../ask/dictate";
import { type SubmitResult, submitRfq } from "./actions";

type Mode = "paste" | "upload" | "call";
type Channel = "" | "portal" | "form";
type Problem = Extract<SubmitResult, { ok: false }>;

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Files dropped or chosen, without the same file twice. */
const addFiles = (current: File[], more: FileList | null) => {
  const next = [...current];
  for (const file of Array.from(more ?? [])) {
    if (!next.some((f) => f.name === file.name && f.size === file.size)) {
      next.push(file);
    }
  }
  return next;
};

const SUBMIT_LABEL: Record<Mode, string> = {
  paste: "Read RFQ",
  upload: "Read RFQ",
  call: "Save call as RFQ",
};

const ChosenFiles = ({
  files,
  disabled,
  onRemove,
}: {
  disabled: boolean;
  files: File[];
  onRemove: (file: File) => void;
}) => (
  <ul className="grid gap-1 text-sm">
    {files.map((f) => (
      <li className="flex items-center gap-2" key={`${f.name}-${f.size}`}>
        <span className="min-w-0 flex-1 truncate">{f.name}</span>
        <span className="text-muted-foreground text-xs">{size(f.size)}</span>
        <Button
          aria-label={`Remove ${f.name}`}
          disabled={disabled}
          onClick={() => onRemove(f)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </li>
    ))}
  </ul>
);

export const NewRfq = ({ canEdit }: { canEdit: boolean }) => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("paste");
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [channel, setChannel] = useState<Channel>("");
  const [over, setOver] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setProblem(null);
      const form = new FormData();
      form.set("mode", mode);
      if (mode === "upload") {
        for (const file of files) {
          form.append("file", file);
        }
        form.set("channel", channel);
      } else {
        form.set("text", mode === "call" ? notes : text);
      }
      const result = await submitRfq(form);
      if (result.ok) {
        setOpen(false);
        setText("");
        setNotes("");
        setFiles([]);
        setChannel("");
        router.push(`/quotes/${result.id}`);
      } else {
        setProblem(result);
      }
    });

  if (!canEdit) {
    return null;
  }
  const ready = {
    paste: text.trim().length > 0,
    upload: files.length > 0,
    call: notes.trim().length >= 10,
  }[mode];

  return (
    <Dialog onOpenChange={(o) => !pending && setOpen(o)} open={open}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon /> New RFQ
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New request for quote</DialogTitle>
          <DialogDescription>
            Paste the customer's email, drop the RFQ package from a portal, or
            note down a call. Takumo reads the parts, quantities, material and
            finish, and keeps the drawings with the RFQ.
          </DialogDescription>
        </DialogHeader>
        <Tabs onValueChange={(v) => setMode(v as Mode)} value={mode}>
          <TabsList>
            <TabsTrigger value="paste">Paste email</TabsTrigger>
            <TabsTrigger value="upload">Upload files</TabsTrigger>
            <TabsTrigger value="call">From a call</TabsTrigger>
          </TabsList>
          <TabsContent value="paste">
            <Textarea
              aria-label="RFQ text"
              className="h-64 font-mono text-xs"
              disabled={pending}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                "From: buyer@customer.com\nSubject: RFQ – brackets\n\nPlease quote 50 / 100 pcs of P-1001 rev B…"
              }
              value={text}
            />
          </TabsContent>
          <TabsContent className="grid gap-3" value="upload">
            <button
              className={cn(
                "flex h-44 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center transition-colors hover:bg-muted/50",
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
                setFiles((f) => addFiles(f, e.dataTransfer.files));
              }}
              type="button"
            >
              <FileTextIcon className="size-6 text-muted-foreground" />
              <span className="text-sm">
                Drop the RFQ and its drawings here, or click to choose
              </span>
              <span className="text-muted-foreground text-xs">
                PDF, Word, saved email (.eml), drawings, STEP/IGES models,
                images or a zip, up to 20 MB in total
              </span>
            </button>
            <input
              accept={PACKAGE_TYPES.join(",")}
              className="hidden"
              multiple
              onChange={(e) => {
                setFiles((f) => addFiles(f, e.target.files));
                e.target.value = "";
              }}
              ref={input}
              type="file"
            />
            {files.length > 0 && (
              <ChosenFiles
                disabled={pending}
                files={files}
                onRemove={(file) =>
                  setFiles((all) => all.filter((x) => x !== file))
                }
              />
            )}
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">It came from</span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-sm"
                disabled={pending}
                onChange={(e) => setChannel(e.target.value as Channel)}
                value={channel}
              >
                <option value="">an email or elsewhere</option>
                <option value="portal">a customer portal</option>
                <option value="form">our website form</option>
              </select>
            </label>
          </TabsContent>
          <TabsContent className="grid gap-2" value="call">
            <Textarea
              aria-label="Call notes"
              className="h-56 text-sm"
              disabled={pending}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Who called, the company, the parts and quantities, material, finish, when they need it…"
              value={notes}
            />
            <div className="flex items-center gap-2">
              <DictateButton
                disabled={pending}
                onError={(message) => setProblem({ ok: false, error: message })}
                onText={(spoken) => {
                  setProblem(null);
                  setNotes((prev) =>
                    prev.trim() ? `${prev.trimEnd()} ${spoken}` : spoken
                  );
                }}
              />
              <span className="text-muted-foreground text-xs">
                Dictate right after the call; edit the text before saving.
              </span>
            </div>
          </TabsContent>
        </Tabs>
        {problem && (
          <p className="text-destructive text-sm">
            {problem.error}
            {problem.existing && (
              <>
                {" "}
                <Link
                  className="underline"
                  href={`/quotes/${problem.existing.id}`}
                  onClick={() => setOpen(false)}
                >
                  Open {problem.existing.label}
                </Link>
              </>
            )}
          </p>
        )}
        <DialogFooter>
          <Button disabled={pending || !ready} onClick={submit}>
            {pending ? (
              <>
                <Spinner /> Reading the RFQ…
              </>
            ) : (
              SUBMIT_LABEL[mode]
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
