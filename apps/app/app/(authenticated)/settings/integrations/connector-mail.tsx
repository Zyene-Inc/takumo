"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useState } from "react";
import type { MailFolder } from "@/lib/connectors/outlook";
import {
  listOutlookFolders,
  saveGmailQuery,
  saveOutlookFolder,
  saveOutlookMailbox,
} from "./actions";
import { useAction } from "./connector-action";

export const GmailQuery = ({ initial }: { initial: string }) => {
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

export const OutlookMailbox = ({ initial }: { initial: string }) => {
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

const SELECT_CLASS =
  "h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm disabled:opacity-50";

/** Which Outlook folder RFQs are read from: the Inbox unless one's chosen. */
export const OutlookFolder = ({ current }: { current: string | null }) => {
  const [folders, setFolders] = useState<{
    inboxId: string | null;
    list: MailFolder[];
  } | null>(null);
  const [chosen, setChosen] = useState("");
  const { message, pending, run, start, setMessage } = useAction();
  const load = () =>
    start(async () => {
      const r = await listOutlookFolders();
      if (r.ok) {
        setFolders({ list: r.folders, inboxId: r.inboxId });
        const match = r.folders.find((f) => f.name === current);
        setChosen(match?.id ?? r.inboxId ?? "");
        setMessage(null);
      } else {
        setMessage({ error: true, text: r.error });
      }
    });
  return (
    <div className="grid gap-1">
      <p className="text-muted-foreground text-xs">
        RFQ folder: {current ?? "Inbox"}. Choose another if a mail rule files
        RFQs into their own folder.
      </p>
      {folders ? (
        <div className="flex gap-2">
          <select
            aria-label="RFQ folder"
            className={SELECT_CLASS}
            disabled={pending}
            onChange={(e) => setChosen(e.target.value)}
            value={chosen}
          >
            {folders.list.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <Button
            disabled={pending || !chosen}
            onClick={() =>
              run(
                () =>
                  saveOutlookFolder(
                    chosen === folders.inboxId ? null : { id: chosen }
                  ),
                (r) => String(r.summary ?? "Saved.")
              )
            }
            size="sm"
            variant="outline"
          >
            {pending && <Spinner />} Save
          </Button>
        </div>
      ) : (
        <div>
          <Button disabled={pending} onClick={load} size="sm" variant="outline">
            {pending && <Spinner />} Choose folder
          </Button>
        </div>
      )}
      {message && (
        <p className={message.error ? "text-destructive text-xs" : "text-xs"}>
          {message.text}
        </p>
      )}
    </div>
  );
};

/** Which emails count as RFQs: extra subject words, and what to leave out. */
