"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useState, useTransition } from "react";
import type { PreviewMessage, RfqRules } from "@/lib/connectors/rfq-rules";
import { previewRfqs, saveRfqRules } from "./actions";
import { useAction } from "./connector-action";

export const RfqRulesEditor = ({
  provider,
  rules,
}: {
  provider: "gmail" | "outlook";
  rules: RfqRules;
}) => {
  const [open, setOpen] = useState(false);
  const [terms, setTerms] = useState(rules.extraTerms.join("\n"));
  const [senders, setSenders] = useState(rules.senders.join("\n"));
  const [attachments, setAttachments] = useState(rules.requireAttachments);
  const [known, setKnown] = useState(rules.knownCustomersOnly);
  const { message, pending, run } = useAction();
  const active =
    rules.extraTerms.length +
    rules.senders.length +
    Number(rules.requireAttachments) +
    Number(rules.knownCustomersOnly);
  const id = `rules-${provider}`;
  return (
    <div className="grid gap-2">
      <div>
        <Button
          onClick={() => setOpen(!open)}
          size="sm"
          type="button"
          variant="ghost"
        >
          RFQ rules{active ? ` (${active} set)` : ""}
        </Button>
      </div>
      {open && (
        <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm">
          <p className="text-muted-foreground text-xs">
            Takumo picks out emails whose subject says RFQ, request for quote,
            quote request or please quote. Add your own words, or narrow it
            down. The test below uses these rules.
          </p>
          <label className="grid gap-1" htmlFor={`${id}-terms`}>
            <span className="font-medium text-xs">
              More subject words, one per line
            </span>
            <Textarea
              disabled={pending}
              id={`${id}-terms`}
              onChange={(e) => setTerms(e.target.value)}
              placeholder={"quotation\nbid request"}
              rows={2}
              value={terms}
            />
          </label>
          {provider === "gmail" && (
            <p className="text-muted-foreground text-xs">
              These are added to Takumo's search. If you've written your own
              Gmail search above, that's used instead.
            </p>
          )}
          <label className="flex items-start gap-2">
            <input
              checked={attachments}
              className="mt-1"
              disabled={pending}
              onChange={(e) => setAttachments(e.target.checked)}
              type="checkbox"
            />
            <span>Only emails with an attachment (a drawing or PDF)</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              checked={known}
              className="mt-1"
              disabled={pending}
              onChange={(e) => setKnown(e.target.checked)}
              type="checkbox"
            />
            <span>
              Only from known customers{" "}
              <span className="text-muted-foreground">
                (companies that sent an RFQ you linked to a customer, plus the
                senders below)
              </span>
            </span>
          </label>
          <label className="grid gap-1" htmlFor={`${id}-senders`}>
            <span className="font-medium text-xs">
              Only from these senders, one per line (blank: anyone)
            </span>
            <Textarea
              disabled={pending}
              id={`${id}-senders`}
              onChange={(e) => setSenders(e.target.value)}
              placeholder={"buyer@customer.com\n@customer.com"}
              rows={2}
              value={senders}
            />
          </label>
          <div className="flex items-center gap-2">
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    saveRfqRules({
                      provider,
                      extraTerms: terms,
                      senders,
                      requireAttachments: attachments,
                      knownCustomersOnly: known,
                    }),
                  () => "Saved. New mail is checked with these rules."
                )
              }
              size="sm"
            >
              {pending && <Spinner />} Save rules
            </Button>
          </div>
          {message && (
            <p
              className={message.error ? "text-destructive text-xs" : "text-xs"}
            >
              {message.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

/** The last 20 emails and which would become RFQs; imports nothing. */
export const RfqPreview = ({ provider }: { provider: string }) => {
  const [messages, setMessages] = useState<PreviewMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const test = () =>
    start(async () => {
      const r = await previewRfqs(provider);
      if (r.ok) {
        setMessages(r.messages);
        setError(null);
      } else {
        setError(r.error);
      }
    });
  const count = messages?.filter((m) => m.isRfq).length ?? 0;
  return (
    <div className="grid gap-2">
      <div>
        <Button disabled={pending} onClick={test} size="sm" variant="outline">
          {pending && <Spinner />} Test with the last 20 emails
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
      {messages && (
        <div className="grid gap-1 text-xs">
          <p className="text-muted-foreground">
            {count} of the last {messages.length} emails would become RFQs.
            Nothing was imported.
          </p>
          <ul className="grid gap-1">
            {messages.map((m) => (
              <li className="flex items-start gap-2" key={m.id}>
                <Badge variant={m.isRfq ? "secondary" : "outline"}>
                  {m.isRfq ? "RFQ" : "Skip"}
                </Badge>
                <span className="min-w-0">
                  <span className="block truncate">
                    {m.subject || "(no subject)"}
                  </span>
                  <span className="block truncate text-muted-foreground">
                    {m.from ?? "Unknown sender"}
                    {m.receivedAt
                      ? ` · ${m.receivedAt.slice(0, 16).replace("T", " ")} UTC`
                      : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

/** What's connected, when it last ran, and what came in. */
