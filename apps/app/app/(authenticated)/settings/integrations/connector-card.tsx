"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  connect,
  disconnectProvider,
  saveGmailQuery,
  syncNow,
} from "./actions";

export interface ConnectorView {
  account: string | null;
  configured: boolean;
  description: string;
  lastError: string | null;
  lastNotes: string[];
  lastSyncAt: string | null;
  name: string;
  provider: "quickbooks" | "gmail";
  query: string | null;
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
          {checked}
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
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {c.status !== "connected" && (
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
              {c.provider === "gmail" ? "Check for RFQs now" : "Sync now"}
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
