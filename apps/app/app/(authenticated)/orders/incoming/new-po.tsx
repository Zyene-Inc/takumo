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
import { FileTextIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { PACKAGE_TYPES } from "@/lib/quotes/file-types";
import { MAX_PART_BYTES, pieces } from "@/lib/quotes/upload-limits";
import { submitPo, uploadPoPart } from "./actions";

type Mode = "upload" | "paste";

/** Send the file a piece at a time (the host caps a request at 4.5 MB). */
const uploadInPieces = async (
  file: File
): Promise<{ ok: true; uploadId: string } | { ok: false; error: string }> => {
  const uploadId = crypto.randomUUID();
  for (const [partIndex, [start, end]] of pieces(
    file.size,
    MAX_PART_BYTES
  ).entries()) {
    const form = new FormData();
    form.set("uploadId", uploadId);
    form.set("fileIndex", "0");
    form.set("partIndex", String(partIndex));
    form.set("name", file.name);
    form.set("part", file.slice(start, end));
    const result = await uploadPoPart(form);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true, uploadId };
};

/** A customer PO that came some other way: upload its file or paste it. */
export const NewPo = ({ canEdit }: { canEdit: boolean }) => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("upload");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!canEdit) {
    return null;
  }
  const ready = mode === "upload" ? file !== null : text.trim().length >= 10;

  const submit = () =>
    start(async () => {
      setError(null);
      const form = new FormData();
      form.set("mode", mode);
      if (mode === "upload" && file) {
        const uploaded = await uploadInPieces(file);
        if (!uploaded.ok) {
          setError(uploaded.error);
          return;
        }
        form.set("uploadId", uploaded.uploadId);
      } else {
        form.set("text", text);
      }
      const result = await submitPo(form);
      if (result.ok) {
        setOpen(false);
        setText("");
        setFile(null);
        router.push(`/orders/incoming/${result.id}`);
      } else {
        setError(result.error);
      }
    });

  return (
    <Dialog onOpenChange={(o) => !pending && setOpen(o)} open={open}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon /> New customer PO
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New customer PO</DialogTitle>
          <DialogDescription>
            Upload the PO (PDF, saved email or a photo) or paste its email.
            Takumo reads the lines, checks them against your quotes, and lays
            them out ready to enter in your ERP.
          </DialogDescription>
        </DialogHeader>
        <Tabs onValueChange={(v) => setMode(v as Mode)} value={mode}>
          <TabsList>
            <TabsTrigger value="upload">Upload the PO</TabsTrigger>
            <TabsTrigger value="paste">Paste email</TabsTrigger>
          </TabsList>
          <TabsContent className="grid gap-3" value="upload">
            <button
              className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center transition-colors hover:bg-muted/50"
              disabled={pending}
              onClick={() => input.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                setFile(e.dataTransfer.files[0] ?? null);
              }}
              type="button"
            >
              <FileTextIcon className="size-6 text-muted-foreground" />
              <span className="text-sm">
                {file ? file.name : "Drop the PO here, or click to choose"}
              </span>
              <span className="text-muted-foreground text-xs">
                PDF, saved email (.eml), Word or an image, up to 20 MB
              </span>
            </button>
            <input
              accept={PACKAGE_TYPES.join(",")}
              className="hidden"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
              ref={input}
              type="file"
            />
          </TabsContent>
          <TabsContent value="paste">
            <Textarea
              aria-label="PO text"
              className="h-56 font-mono text-xs"
              disabled={pending}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                "From: buyer@customer.com\nSubject: PO 4500123\n\nPlease supply 200 pcs CM-1042 rev C at $19.75…"
              }
              value={text}
            />
          </TabsContent>
        </Tabs>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button disabled={pending || !ready} onClick={submit}>
            {pending ? (
              <>
                <Spinner /> Reading the PO…
              </>
            ) : (
              "Read PO"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
