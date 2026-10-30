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
import { FileTextIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { RFQ_TYPES } from "@/lib/quotes/types";
import { submitRfq } from "./actions";

export const NewRfq = ({ canEdit }: { canEdit: boolean }) => {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setError(null);
      const form = new FormData();
      if (tab === "upload" && file) {
        form.set("file", file);
      } else {
        form.set("text", text);
      }
      const result = await submitRfq(form);
      if (result.ok) {
        setOpen(false);
        setText("");
        setFile(null);
        router.push(`/quotes/${result.id}`);
      } else {
        setError(result.error);
      }
    });

  if (!canEdit) {
    return null;
  }
  const ready = tab === "upload" ? Boolean(file) : text.trim().length > 0;

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
            Paste the customer's email or upload the RFQ. Takumo reads the
            parts, quantities, material and finish, and matches them to your
            shop.
          </DialogDescription>
        </DialogHeader>
        <Tabs onValueChange={setTab} value={tab}>
          <TabsList>
            <TabsTrigger value="paste">Paste email</TabsTrigger>
            <TabsTrigger value="upload">Upload file</TabsTrigger>
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
          <TabsContent value="upload">
            <button
              className={cn(
                "flex h-64 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center transition-colors hover:bg-muted/50",
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
                setFile(e.dataTransfer.files[0] ?? null);
              }}
              type="button"
            >
              <FileTextIcon className="size-6 text-muted-foreground" />
              {file ? (
                <span className="font-medium text-sm">{file.name}</span>
              ) : (
                <span className="text-sm">
                  Drop the RFQ here or click to choose
                </span>
              )}
              <span className="text-muted-foreground text-xs">
                PDF, Word, saved email (.eml) or text, up to 10 MB
              </span>
            </button>
            <input
              accept={RFQ_TYPES.join(",")}
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              ref={input}
              type="file"
            />
          </TabsContent>
        </Tabs>
        {error && <p className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button disabled={pending || !ready} onClick={submit}>
            {pending ? (
              <>
                <Spinner /> Reading the RFQ…
              </>
            ) : (
              "Read RFQ"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
