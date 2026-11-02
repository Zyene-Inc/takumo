"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { PreviewMessage } from "@/lib/connectors/rfq-rules";
import {
  connect,
  disconnectProvider,
  previewRfqs,
  saveGmailQuery,
  saveOutlookMailbox,
  syncNow,
} from "./actions";

export interface ConnectorView {
  account: string | null;
  configured: boolean;
  description: string;
  /** Outlook: new-mail notifications are on (else hourly checks only). */
  instant: boolean;
  lastError: string | null;
  lastNotes: string[];
  lastSyncAt: string | null;
  name: string;
  /** Gmail connected before Takumo asked to write reply drafts. */
  needsDraftAccess: boolean;
  provider: "quickbooks" | "gmail" | "outlook";
  query: string | null;
  sharedMailbox: string | null;
  status: string | null;
}

const useAction = () => {
  const router = useRouter();
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [pending, start] = useTransition();
  const run = (
    fn: () => Promise<
      { ok: boolean; error?: string } & Record<string, unknown>
    >,
    done?: (r: Record<string, unknown>) => string | null
  ) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        const text = done?.(r) ?? null;
        setMessage(text ? { error: false, text } : null);
        router.refresh();
      } else {
        setMessage({ error: true, text: r.error ?? "Something went wrong." });
      }
    });
  return { message, pending, run, start, setMessage };
};

const GmailQuery = ({ initial }: { initial: string }) => {
  const [query, setQuery] = useState(initial);
  const { message, pending, run } = useAction();
  return (
    <div className="grid gap-1">
      <label className="text-muted-foreground text-xs" htmlFor="gmail-query">
        Gmail search for RFQs
      </label>
      <div className="flex gap-2">
        <Input
          id="gmail-query"
          onChange={(e) => setQuery(e.target.value)}
          value={query}
        />
        <Button
          disabled={pending || query === initial}
          onClick={() =>
            run(
              () => saveGmailQuery(query),
              () => "Saved."
            )
          }
          size="sm"
          variant="outline"
        >
          Save
        </Button>
      </div>
      {message && (
        <p className={message.error ? "text-destructive text-xs" : "text-xs"}>
          {message.text}
        </p>
      )}
    </div>
  );
};

const OutlookMailbox = ({ initial }: { initial: string }) => {
  const [address, setAddress] = useState(initial);
  const { message, pending, run } = useAction();
  return (
    <div className="grid gap-1">
      <label
        className="text-muted-foreground text-xs"
        htmlFor="outlook-mailbox"
      >
        Shared RFQ mailbox (optional, e.g. rfq@yourshop.com). Leave blank to use
        your own inbox. Shared mailboxes are checked every hour.
      </label>
      <div className="flex gap-2">
        <Input
          id="outlook-mailbox"
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Your own inbox"
          type="email"
          value={address}
        />
        <Button
          disabled={pending || address.trim() === initial}
          onClick={() =>
            run(
              () => saveOutlookMailbox(address),
              (r) => String(r.summary ?? "Saved.")
            )
          }
          size="sm"
          variant="outline"
        >
          {pending && <Spinner />} Save
        </Button>
      </div>
      {message && (
        <p className={message.error ? "text-destructive text-xs" : "text-xs"}>
          {message.text}
        </p>
      )}
    </div>
  );
};

/** The last 20 emails and which would become RFQs; imports nothing. */
const RfqPreview = ({ provider }: { provider: string }) => {
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
const ConnectorStatus = ({ c }: { c: ConnectorView }) => {
  const connected = c.status !== null;
  const checked = c.lastSyncAt
    ? ` · last checked ${c.lastSyncAt.slice(0, 16).replace("T", " ")} UTC`
    : " · first sync running";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{c.name}</h2>
        {c.status === "connected" && (
          <Badge variant="secondary">Connected</Badge>
        )}
        {c.status === "error" && (
          <Badge variant="destructive">Needs reconnecting</Badge>
        )}
        {!c.configured && (
          <Badge variant="outline">Not set up on this server</Badge>
        )}
      </div>
      <p className="text-muted-foreground text-sm">{c.description}</p>
      {connected && (
        <p className="text-sm">
          {c.account}
          {c.sharedMailbox ? ` · reading ${c.sharedMailbox}` : ""}
          {checked}
        </p>
      )}
      {c.provider === "outlook" && c.status === "connected" && (
        <p className="text-muted-foreground text-xs">
          {c.instant
            ? "New mail arrives within a couple of minutes, and is checked every hour as well."
            : "New mail is checked every hour."}
        </p>
      )}
      {c.needsDraftAccess && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:bg-amber-950 dark:text-amber-100">
          Reconnect Gmail to let Takumo prepare reply drafts. Drafts stay in
          your Gmail for you to review and send; Takumo never sends email.
        </p>
      )}
      {c.lastError && <p className="text-destructive text-sm">{c.lastError}</p>}
      {c.lastNotes.length > 0 && (
        <ul className="list-disc pl-4 text-muted-foreground text-xs">
          {c.lastNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </>
  );
};

export const ConnectorCard = ({
  c,
  canManage,
}: {
  c: ConnectorView;
  canManage: boolean;
}) => {
  const { message, pending, run, start, setMessage } = useAction();
  const connected = c.status !== null;
  const goConnect = () =>
    start(async () => {
      const r = await connect(c.provider);
      if (r.ok) {
        window.location.assign(r.url);
      } else {
        setMessage({ error: true, text: r.error });
      }
    });

  return (
    <section className="grid gap-3 rounded-xl border p-4">
      <ConnectorStatus c={c} />
      {connected && c.provider === "gmail" && canManage && (
        <GmailQuery initial={c.query ?? ""} />
      )}
      {connected && c.provider === "outlook" && canManage && (
        <OutlookMailbox initial={c.sharedMailbox ?? ""} />
      )}
      {c.status === "connected" && c.provider !== "quickbooks" && canManage && (
        <RfqPreview provider={c.provider} />
      )}
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {(c.status !== "connected" || c.needsDraftAccess) && (
            <Button
              disabled={pending || !c.configured}
              onClick={goConnect}
              size="sm"
            >
              {pending && <Spinner />}{" "}
              {connected ? "Reconnect" : `Connect ${c.name}`}
            </Button>
          )}
          {c.status === "connected" && (
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () => syncNow(c.provider),
                  (r) => String(r.summary ?? "")
                )
              }
              size="sm"
              variant="outline"
            >
              {pending && <Spinner />}{" "}
              {c.provider === "quickbooks" ? "Sync now" : "Check for RFQs now"}
            </Button>
          )}
          {connected && (
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  () => disconnectProvider(c.provider),
                  () => "Disconnected."
                )
              }
              size="sm"
              variant="ghost"
            >
              Disconnect
            </Button>
          )}
        </div>
      )}
      {message && (
        <p className={message.error ? "text-destructive text-sm" : "text-sm"}>
          {message.text}
        </p>
      )}
    </section>
  );
};
