"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowRightIcon, CheckIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SUBJECT_LABEL, type SubjectType } from "@/lib/facts/attributes";
import { approve, reject } from "./actions";

export interface FactView {
  attribute: string;
  byTakumo: boolean;
  createdAt: string;
  /** The record's value now (pending model facts). */
  current: string | null;
  evidence: string | null;
  id: string;
  isNote: boolean;
  label: string;
  note: { kind: string; text: string } | null;
  numeric: boolean;
  /** The value it replaced (approved facts). */
  previous: string | null;
  rawValue: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  source: string;
  status: string;
  subject: string;
  subjectType: string;
  unit: string | null;
  value: string;
}

export const SOURCE_LABEL: Record<string, string> = {
  chat: "Ask Takumo",
  voice: "Voice note",
  note: "Typed note",
  floor: "Shop floor",
  recalibration: "Recalibration",
  manual: "Added by hand",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  pending: "secondary",
  approved: "default",
  superseded: "outline",
  rejected: "outline",
};

const day = (iso: string) => iso.slice(0, 10);

const approveLabel = (edited: boolean, isNote: boolean) => {
  if (edited) {
    return "Approve with this value";
  }
  return isNote ? "Approve" : "Approve and apply";
};

/** What the fact says: the change (current → proposed) or the note. */
const FactBody = ({ fact }: { fact: FactView }) => {
  const before = fact.status === "pending" ? fact.current : fact.previous;
  return (
    <div>
      <p className="text-muted-foreground text-xs">
        {SUBJECT_LABEL[fact.subjectType as SubjectType] ?? fact.subjectType} ·{" "}
        {fact.attribute}
      </p>
      <p className="font-medium">{fact.subject}</p>
      {fact.isNote ? (
        <p className="mt-1 whitespace-pre-line">{fact.value}</p>
      ) : (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-lg">
          {before && (
            <>
              <span
                className={cn(
                  "text-muted-foreground",
                  fact.status !== "superseded" && "line-through"
                )}
              >
                {before}
              </span>
              <ArrowRightIcon className="size-4 text-muted-foreground" />
            </>
          )}
          <span className="font-semibold">{fact.value}</span>
        </p>
      )}
    </div>
  );
};

/** Approve (optionally with a corrected number) or reject a pending fact. */
const ReviewControls = ({ fact }: { fact: FactView }) => {
  const router = useRouter();
  const [value, setValue] = useState(fact.rawValue);
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const edited = value.trim() !== fact.rawValue;

  const act = (action: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await action();
      if (r.ok) {
        setError(null);
        router.refresh();
      } else {
        setError(r.error ?? "Something went wrong.");
      }
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      {fact.numeric && (
        <div className="flex items-center gap-1">
          <Input
            aria-label={`Value to approve for ${fact.label}`}
            className="h-8 w-28"
            inputMode="decimal"
            onChange={(e) => setValue(e.target.value)}
            value={value}
          />
          {fact.unit && (
            <span className="text-muted-foreground text-sm">{fact.unit}</span>
          )}
        </div>
      )}
      <Button
        disabled={pending}
        onClick={() =>
          act(() => approve(fact.id, edited ? value : null, note || null))
        }
        size="sm"
      >
        {pending ? <Spinner /> : <CheckIcon />}
        {approveLabel(edited, fact.isNote)}
      </Button>
      {rejecting && (
        <>
          <Input
            aria-label="Why it's rejected"
            className="h-8 w-64"
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why (optional)"
            value={note}
          />
          <Button
            disabled={pending}
            onClick={() => act(() => reject(fact.id, note || null))}
            size="sm"
            variant="outline"
          >
            <XIcon /> Reject
          </Button>
          <Button onClick={() => setRejecting(false)} size="sm" variant="ghost">
            Cancel
          </Button>
        </>
      )}
      {!rejecting && (
        <Button onClick={() => setRejecting(true)} size="sm" variant="ghost">
          <XIcon /> Reject
        </Button>
      )}
      {error && <span className="text-destructive text-sm">{error}</span>}
    </div>
  );
};

export const FactCard = ({
  fact,
  canReview,
}: {
  canReview: boolean;
  fact: FactView;
}) => (
  <article className="grid gap-3 rounded-xl border p-4" id={fact.label}>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-mono text-muted-foreground">{fact.label}</span>
      <Badge variant={STATUS_VARIANT[fact.status] ?? "outline"}>
        {fact.status}
      </Badge>
      <Badge variant="outline">
        {SOURCE_LABEL[fact.source] ?? fact.source}
      </Badge>
      <span className="text-muted-foreground">
        {fact.byTakumo ? "Proposed by Takumo" : "Stated"} {day(fact.createdAt)}
        {fact.reviewedAt && ` · reviewed ${day(fact.reviewedAt)}`}
      </span>
    </div>
    <FactBody fact={fact} />
    {fact.evidence && (
      <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
        <span className="text-muted-foreground">Evidence: </span>
        {fact.evidence}
      </p>
    )}
    {fact.note && (
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          From a {fact.note.kind === "voice" ? "voice" : "typed"} note
        </summary>
        <p className="mt-1 whitespace-pre-line">{fact.note.text}</p>
      </details>
    )}
    {fact.reviewNote && (
      <p className="text-muted-foreground text-sm">
        Reviewer: {fact.reviewNote}
      </p>
    )}
    {canReview && fact.status === "pending" && <ReviewControls fact={fact} />}
  </article>
);
