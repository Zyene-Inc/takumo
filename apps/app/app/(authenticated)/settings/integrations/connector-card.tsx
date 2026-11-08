"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import type { RfqRules } from "@/lib/connectors/rfq-rules";
import { connect, disconnectProvider, syncNow } from "./actions";
import { useAction } from "./connector-action";
import { GmailQuery, OutlookFolder, OutlookMailbox } from "./connector-mail";
import { RfqPreview, RfqRulesEditor } from "./connector-rfq";

export interface ConnectorView {
  account: string | null;
  configured: boolean;
  description: string;
  /** Outlook: the folder RFQs are read from (null: the Inbox). */
  folderName: string | null;
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
  /** Which emails count as RFQs, on top of Takumo's own rules. */
  rules: RfqRules;
  sharedMailbox: string | null;
  status: string | null;
}

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
          {c.folderName ? ` · folder ${c.folderName}` : ""}
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
      {c.status === "connected" && c.provider === "outlook" && canManage && (
        <OutlookFolder current={c.folderName} />
      )}
      {connected && c.provider !== "quickbooks" && canManage && (
        <RfqRulesEditor provider={c.provider} rules={c.rules} />
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
