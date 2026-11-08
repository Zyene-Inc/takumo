"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { cn } from "@repo/design-system/lib/utils";
import {
  ArrowRightIcon,
  CheckIcon,
  LockIcon,
  MegaphoneIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SUBJECT_LABEL, type SubjectType } from "@/lib/facts/attributes";
import { approve, publish, reject } from "./actions";

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
  /** Published to the whole company on purpose. */
  published: boolean;
  rawValue: string;
  /**
   * Not everyone may see it: it came from documents not everyone may open
   * (or its origin isn't known while some documents are restricted).
   */
  restricted: boolean;
  reviewedAt: string | null;
  reviewNote: string | null;
  source: string;
  status: string;
  subject: string;
  subjectType: string;
  unit: string | null;
  value: string;
}

const SOURCE_LABEL: Record<string, string> = {
  chat: "Ask Takumo",
  voice: "Voice note",
  note: "Typed note",
  floor: "Shop floor",
  recalibration: "Recalibration",
  document: "Document",
  manual: "Added by hand",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  pending: "secondary",
  approved: "default",
  superseded: "outline",
  rejected: "outline",
};

const day = (iso: string) => iso.slice(0, 10);

const PUBLISH_EXPLAINED =
  "Everyone in the shop will see this fact. Its quotes stay hidden from people who can't open the documents it came from. This is recorded.";

/** "Are you sure" for publishing, inline under the buttons. */
const PublishConfirm = ({
  label,
  onConfirm,
  onCancel,
  pending,
}: {
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) => (
  <div className="grid w-full gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
    <p>{PUBLISH_EXPLAINED}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={pending} onClick={onConfirm} size="sm">
        {pending ? <Spinner /> : <MegaphoneIcon />}
        {label}
      </Button>
      <Button onClick={onCancel} size="sm" variant="ghost">
        Cancel
      </Button>
    </div>
  </div>
);

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
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const edited = value.trim() !== fact.rawValue;
  // Approving a restricted number writes it into a record everyone sees.
  const publishes = fact.restricted && !fact.published && !fact.isNote;
  const approveNow = () =>
    act(() => approve(fact.id, edited ? value : null, note || null, publishes));

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
        disabled={pending || confirming}
        onClick={() => (publishes ? setConfirming(true) : approveNow())}
        size="sm"
      >
        {pending ? <Spinner /> : <CheckIcon />}
        {publishes ? "Approve and publish…" : approveLabel(edited, fact.isNote)}
      </Button>
      {confirming && (
        <PublishConfirm
          label="Publish and approve"
          onCancel={() => setConfirming(false)}
          onConfirm={approveNow}
          pending={pending}
        />
      )}
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

/** Publish an approved restricted fact to the whole company. */
const PublishControls = ({ fact }: { fact: FactView }) => {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      const r = await publish(fact.id);
      if (r.ok) {
        setError(null);
        setConfirming(false);
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {confirming ? (
        <PublishConfirm
          label="Publish to company"
          onCancel={() => setConfirming(false)}
          onConfirm={run}
          pending={pending}
        />
      ) : (
        <Button onClick={() => setConfirming(true)} size="sm" variant="outline">
          <MegaphoneIcon /> Publish to company…
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
      {fact.restricted && !fact.published && (
        <Badge
          title="Only people who may open the documents it came from see this fact."
          variant="secondary"
        >
          <LockIcon /> Restricted
        </Badge>
      )}
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
    {canReview &&
      fact.status === "approved" &&
      fact.restricted &&
      !fact.published && <PublishControls fact={fact} />}
  </article>
);
