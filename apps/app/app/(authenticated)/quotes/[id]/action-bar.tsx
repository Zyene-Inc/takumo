"use client";

// The RFQ's actions: re-read, screen, draft, approve and the more menu.

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  CheckIcon,
  FileDownIcon,
  MoreHorizontalIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import { STATUS_LABEL } from "@/lib/quotes/types";
import type { RfqView } from "@/lib/quotes/view";
import { localToday } from "../../schedule/gantt";
import {
  approve,
  deleteRfq,
  draftQuote,
  rereadRfq,
  setDeclined,
} from "../actions";
import { STATUS_VARIANT } from "../status";
import { Confirm } from "./confirm";

export const EDITABLE = ["review", "drafted", "failed"];

export type Run = (
  label: string,
  action: () => Promise<
    { ok: boolean; error?: string } & Record<string, unknown>
  >,
  done?: (r: Record<string, unknown>) => string | null
) => void;

export const draftLabel = (
  drafting: boolean,
  undrafted: number,
  total: number
) => {
  if (drafting) {
    return "Drafting…";
  }
  if (undrafted === total) {
    return "Draft quote";
  }
  return `Draft ${undrafted} line${undrafted === 1 ? "" : "s"}`;
};

export const MoreMenu = ({
  rfq,
  editable,
  draftable,
  pending,
  run,
  onDraftAll,
  onDeleted,
}: {
  draftable: boolean;
  editable: boolean;
  onDeleted: (error: string | null) => void;
  onDraftAll: () => void;
  pending: boolean;
  rfq: RfqView;
  run: Run;
}) => {
  const [confirming, setConfirming] = useState<"reread" | "delete" | null>(
    null
  );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More actions"
            disabled={pending}
            size="icon"
            variant="ghost"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {draftable && rfq.status === "drafted" && (
            <DropdownMenuItem onSelect={onDraftAll}>
              Re-draft every line
            </DropdownMenuItem>
          )}
          {editable && (
            <DropdownMenuItem onSelect={() => setConfirming("reread")}>
              Read the RFQ again
            </DropdownMenuItem>
          )}
          {editable && (
            <DropdownMenuItem
              onSelect={() => run("decline", () => setDeclined(rfq.id, true))}
            >
              Decline (no quote)
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => setConfirming("delete")}
          >
            Delete RFQ
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Confirm
        action="Read again"
        description="Its lines, drafts and your edits are replaced by a fresh reading."
        onConfirm={() => run("reread", () => rereadRfq(rfq.id))}
        onOpenChange={(open) => setConfirming(open ? "reread" : null)}
        open={confirming === "reread"}
        title="Read the RFQ again?"
      />
      <Confirm
        action="Delete"
        description="The RFQ and its drafts are deleted. This can't be undone."
        onConfirm={async () =>
          onDeleted(
            (await deleteRfq(rfq.id)).ok
              ? null
              : "Quoted RFQs are kept with their quotes."
          )
        }
        onOpenChange={(open) => setConfirming(open ? "delete" : null)}
        open={confirming === "delete"}
        title={`Delete ${rfq.label}?`}
      />
    </>
  );
};

export const ActionBar = ({
  rfq,
  canEdit,
  pending,
  busy,
  run,
  onDeleted,
}: {
  busy: string | null;
  canEdit: boolean;
  onDeleted: (error: string | null) => void;
  pending: boolean;
  rfq: RfqView;
  run: Run;
}) => {
  const editable = canEdit && EDITABLE.includes(rfq.status);
  const draftable = canEdit && ["review", "drafted"].includes(rfq.status);
  const undrafted = rfq.lines.filter((l) => !l.draft).length;
  const quoted = rfq.lines.some((l) => l.quote);
  const draft = (redo: boolean) =>
    run(
      redo ? "redraft" : "draft",
      () => draftQuote(rfq.id, localToday(), redo),
      (r) => {
        const errors = (r.errors as string[] | undefined) ?? [];
        return errors.length ? errors.join(" ") : null;
      }
    );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="font-semibold text-xl">{rfq.label}</h1>
          <Badge variant={STATUS_VARIANT[rfq.status]}>
            {STATUS_LABEL[rfq.status]}
          </Badge>
        </div>
        <p className="truncate text-muted-foreground text-sm">
          {[rfq.subject, rfq.sender, rfq.fileName]
            .filter(Boolean)
            .join(" · ") || "Pasted RFQ"}{" "}
          · received {rfq.receivedAt.slice(0, 10)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {draftable && undrafted > 0 && (
          <Button
            disabled={pending}
            onClick={() => draft(false)}
            size="sm"
            variant={rfq.status === "review" ? "default" : "outline"}
          >
            {busy === "draft" ? <Spinner /> : <SparklesIcon />}
            {draftLabel(busy === "draft", undrafted, rfq.lines.length)}
          </Button>
        )}
        {draftable && rfq.status === "drafted" && (
          <Button
            disabled={pending || rfq.problems.length > 0}
            onClick={() =>
              run(
                "approve",
                () => approve(rfq.id),
                (r) =>
                  `Quoted as ${(r.quoteNos as string[]).join(", ")}. Send the reply draft from your mailbox, or download the PDF and send it with the email beside it.`
              )
            }
            size="sm"
          >
            {busy === "approve" ? <Spinner /> : <CheckIcon />} Approve quote
          </Button>
        )}
        {(quoted || rfq.reply) && (
          <Button asChild size="sm" variant="outline">
            <a href={`/quotes/${rfq.id}/pdf`} rel="noopener" target="_blank">
              <FileDownIcon /> Quote PDF
            </a>
          </Button>
        )}
        {canEdit && rfq.status === "declined" && (
          <Button
            disabled={pending}
            onClick={() => run("reopen", () => setDeclined(rfq.id, false))}
            size="sm"
            variant="outline"
          >
            Reopen
          </Button>
        )}
        {canEdit &&
          (editable || ["declined", "reading"].includes(rfq.status)) && (
            <MoreMenu
              draftable={draftable}
              editable={editable}
              onDeleted={onDeleted}
              onDraftAll={() => draft(true)}
              pending={pending}
              rfq={rfq}
              run={run}
            />
          )}
      </div>
    </div>
  );
};

export const StatusAlerts = ({
  rfq,
  busy,
  message,
  canEdit,
}: {
  busy: string | null;
  canEdit: boolean;
  message: { error: boolean; text: string } | null;
  rfq: RfqView;
}) => (
  <>
    {(busy === "draft" || busy === "redraft") && (
      <Alert>
        <Spinner />
        <AlertTitle>Drafting the quote</AlertTitle>
        <AlertDescription>
          Finding comparable jobs, building the cost and fitting each quantity
          into the schedule. New parts take longer: Takumo estimates their
          operations first.
        </AlertDescription>
      </Alert>
    )}
    {message && (
      <Alert variant={message.error ? "destructive" : "default"}>
        <AlertDescription>{message.text}</AlertDescription>
      </Alert>
    )}
    {rfq.error && rfq.status === "failed" && (
      <Alert variant="destructive">
        <AlertTitle>Takumo couldn't read this RFQ</AlertTitle>
        <AlertDescription>{rfq.error}</AlertDescription>
      </Alert>
    )}
    {rfq.status === "drafted" && rfq.problems.length > 0 && canEdit && (
      <Alert>
        <AlertTitle>Before you approve</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-4">
            {rfq.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    )}
  </>
);
