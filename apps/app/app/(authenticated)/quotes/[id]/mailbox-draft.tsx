"use client";

// The reply draft in the customer's mailbox thread.

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { FileDownIcon, MailIcon } from "lucide-react";
import type { RfqView } from "@/lib/quotes/view";
import { updateReplyDraft } from "../actions";
import type { Run } from "./action-bar";
import { Section } from "./rfq-details";

export const MAILBOX: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export type Reply = NonNullable<RfqView["reply"]>;

export const recipient = (reply: Reply) => {
  if (reply.inThread) {
    return ", in the customer's thread";
  }
  return reply.to ? `, to ${reply.to}` : "";
};

export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

export const DraftStatus = ({ reply }: { reply: Reply | null }) => {
  if (!reply) {
    return (
      <p className="text-muted-foreground text-sm">
        Every line has a price. Put the reply in your mailbox as a draft, with
        the quote PDF attached.
      </p>
    );
  }
  if (reply.sent) {
    return (
      <p className="text-sm">
        Sent {when(reply.sent.at)}
        {reply.mailbox ? ` from ${reply.mailbox}` : ""}.{" "}
        {reply.sent.prices.length > 0 &&
          `${plural(reply.sent.prices.length, "price")} read from it.`}
      </p>
    );
  }
  if (reply.pdfOnly) {
    return (
      <p className="text-sm">
        The quote PDF is ready. Download it and send it with your reply.
      </p>
    );
  }
  return (
    <p className="text-sm">
      In your {MAILBOX[reply.provider] ?? "mailbox"} drafts{recipient(reply)},
      with the quote PDF attached. Updated {when(reply.updatedAt)}. Check it and
      send it from there; Takumo never sends it.
    </p>
  );
};

/** Where the reply draft is, and the button to make or refresh it (F2.5). */
export const MailboxDraft = ({
  rfq,
  canEdit,
  pending,
  busy,
  run,
}: {
  busy: string | null;
  canEdit: boolean;
  pending: boolean;
  rfq: RfqView;
  run: Run;
}) => {
  const reply = rfq.reply;
  const priced =
    rfq.lines.length > 0 && rfq.lines.every((l) => l.quote || l.sendFinal);
  const open = ["review", "drafted", "quoted"].includes(rfq.status);
  if (!(reply || (priced && open))) {
    return null;
  }
  return (
    <Section title="Reply draft">
      <div className="grid gap-3">
        <DraftStatus reply={reply} />
        {reply?.note && (
          <p className="text-muted-foreground text-sm">{reply.note}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {canEdit && open && !reply?.sent && priced && (
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  "reply",
                  () => updateReplyDraft(rfq.id),
                  (r) => (r.message as string | undefined) ?? null
                )
              }
              size="sm"
              variant={reply ? "outline" : "default"}
            >
              {busy === "reply" ? <Spinner /> : <MailIcon />}
              {reply ? "Update draft" : "Create draft"}
            </Button>
          )}
          {reply && (
            <Button asChild size="sm" variant="ghost">
              <a href={`/quotes/${rfq.id}/pdf`} rel="noopener" target="_blank">
                <FileDownIcon /> Download the quote PDF
              </a>
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
};
