// Reading the mailbox: delta queries for new RFQ mail, previews and folders.

import {
  DEFAULT_RULES,
  isRfqSubject,
  type PreviewMessage,
  type RfqRules,
  senderPasses,
} from "../rfq-rules";
import { MILLISECONDS } from "./auth";
import {
  type Fetch,
  GRAPH_API,
  graph,
  IMMUTABLE_IDS,
  json,
  MAX_MESSAGES,
  MAX_PAGES,
  mailboxPath,
  OutlookDeltaExpired,
  PAGE_SIZE,
} from "./graph";

/** The signed-in mailbox's address (work accounts may have only a UPN). */
export const mailbox = async (fetcher: Fetch, accessToken: string) => {
  const me = await json<{ mail?: string | null; userPrincipalName?: string }>(
    await graph(
      fetcher,
      accessToken,
      "/me?$select=mail,userPrincipalName,displayName"
    )
  );
  const address = me.mail || me.userPrincipalName;
  if (!address) {
    throw new Error("This Microsoft account has no mailbox.");
  }
  return address;
};

export interface GraphMessage {
  "@removed"?: { reason: string };
  conversationId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  hasAttachments?: boolean;
  id: string;
  isDraft?: boolean;
  receivedDateTime?: string;
  subject?: string | null;
}

export const SELECT =
  "subject,from,receivedDateTime,hasAttachments,isDraft,conversationId";

// Graph wants "$select", not "%24select"; values are still encoded.
export const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

/** The folder RFQs are read from unless the shop picks another. */
export const DEFAULT_FOLDER = "inbox";

export const folderPath = (folder: string | null | undefined) =>
  `/mailFolders/${encodeURIComponent(folder || DEFAULT_FOLDER)}`;

/**
 * The first delta request for the RFQ folder (the Inbox unless the shop chose
 * another): only newly created mail from here on, starting with what arrived
 * since `since`.
 */
export const firstDeltaUrl = (
  sharedMailbox: string | null | undefined,
  since: Date,
  folder?: string | null
) =>
  `${GRAPH_API}${mailboxPath(sharedMailbox)}${folderPath(folder)}/messages/delta?${query(
    {
      changeType: "created",
      $select: SELECT,
      $filter: `receivedDateTime ge ${since.toISOString().replace(MILLISECONDS, "Z")}`,
    }
  )}`;

/**
 * One round of a delta query: every page (following @odata.nextLink) until
 * Graph hands back the @odata.deltaLink to start from next time.
 */
export const readDelta = async (
  fetcher: Fetch,
  accessToken: string,
  url: string,
  sharedMailbox?: string | null
) => {
  const messages: GraphMessage[] = [];
  let next: string | undefined = url;
  for (let page = 0; next && page < MAX_PAGES; page += 1) {
    const response = await graph(fetcher, accessToken, next, {
      sharedMailbox,
      headers: { Prefer: `odata.maxpagesize=${PAGE_SIZE}, ${IMMUTABLE_IDS}` },
    });
    if (response.status === 410) {
      throw new OutlookDeltaExpired("The saved Outlook position expired.");
    }
    const body = await json<{
      "@odata.deltaLink"?: string;
      "@odata.nextLink"?: string;
      value?: GraphMessage[];
    }>(response);
    // Deleted or moved-away messages show up as "@removed": nothing to read.
    messages.push(...(body.value ?? []).filter((m) => !m["@removed"]));
    if (body["@odata.deltaLink"]) {
      return { messages, deltaLink: body["@odata.deltaLink"] };
    }
    next = body["@odata.nextLink"];
  }
  // Ran out of pages before the round finished: keep the old position.
  return { messages, deltaLink: null };
};

/**
 * The messages to read into RFQs, oldest first: RFQ subjects only (with the
 * shop's extra words), no drafts, nothing the mailbox itself sent, and only
 * what the shop's rules let through (attachments, senders).
 */
export const rfqMessages = (
  messages: GraphMessage[],
  ownAddress: string,
  rules: RfqRules = DEFAULT_RULES,
  /** The rules' sender filter (null: anyone). */
  allowed: string[] | null = null
) =>
  messages
    .filter((m) => {
      const from = m.from?.emailAddress?.address ?? null;
      return (
        !m.isDraft &&
        isRfqSubject(m.subject, rules.extraTerms) &&
        from?.toLowerCase() !== ownAddress.toLowerCase() &&
        !(rules.requireAttachments && !m.hasAttachments) &&
        senderPasses(from, allowed)
      );
    })
    .sort((a, b) =>
      (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? "")
    );

/** The message as an .eml file (its MIME content). */
export const rawMessage = async (
  fetcher: Fetch,
  accessToken: string,
  id: string,
  sharedMailbox?: string | null
) => {
  const response = await graph(
    fetcher,
    accessToken,
    `${mailboxPath(sharedMailbox)}/messages/${encodeURIComponent(id)}/$value`
  );
  if (!response.ok) {
    throw new Error(`Outlook returned an error (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

/** The last 20 emails in the RFQ folder, each marked whether it would become an RFQ. */
export const previewMessages = async (
  fetcher: Fetch,
  accessToken: string,
  ownAddress: string,
  sharedMailbox?: string | null,
  options: {
    allowed?: string[] | null;
    folder?: string | null;
    rules?: RfqRules;
  } = {}
): Promise<PreviewMessage[]> => {
  const { value } = await json<{ value?: GraphMessage[] }>(
    await graph(
      fetcher,
      accessToken,
      `${mailboxPath(sharedMailbox)}${folderPath(options.folder)}/messages?${query(
        {
          $select: SELECT,
          $orderby: "receivedDateTime desc",
          $top: String(MAX_MESSAGES),
        }
      )}`,
      { sharedMailbox }
    )
  );
  const rfqs = new Set(
    rfqMessages(
      value ?? [],
      ownAddress,
      options.rules,
      options.allowed ?? null
    ).map((m) => m.id)
  );
  return (value ?? []).map((m) => ({
    id: m.id,
    subject: m.subject ?? null,
    from: m.from?.emailAddress?.address ?? null,
    receivedAt: m.receivedDateTime ?? null,
    isRfq: rfqs.has(m.id),
  }));
};

export interface MailFolder {
  id: string;
  /** "Inbox", or "Inbox / RFQs" for a folder inside another. */
  name: string;
}

export interface GraphFolder {
  childFolderCount?: number;
  displayName?: string;
  id: string;
}

export const FOLDER_FIELDS = "id,displayName,childFolderCount";

/** Folders listed per level; more than this is unusual for an RFQ mailbox. */
export const MAX_FOLDERS = 100;

/**
 * The mailbox's folders and the folders one level inside them, for choosing
 * where RFQs land, plus which one is the Inbox (its id, not its name, which
 * depends on the mailbox's language).
 */
export const listFolders = async (
  fetcher: Fetch,
  accessToken: string,
  sharedMailbox?: string | null
): Promise<{ folders: MailFolder[]; inboxId: string | null }> => {
  const base = mailboxPath(sharedMailbox);
  const list = async (path: string) =>
    (
      await json<{ value?: GraphFolder[] }>(
        await graph(
          fetcher,
          accessToken,
          `${base}${path}?${query({ $select: FOLDER_FIELDS, $top: String(MAX_FOLDERS) })}`,
          { sharedMailbox }
        )
      )
    ).value ?? [];
  const [top, inbox] = await Promise.all([
    list("/mailFolders"),
    graph(fetcher, accessToken, `${base}/mailFolders/inbox?$select=id`, {
      sharedMailbox,
    }).then((r) => (r.ok ? (r.json() as Promise<{ id?: string }>) : null)),
  ]);
  const folders: MailFolder[] = [];
  for (const folder of top) {
    const name = folder.displayName || "(unnamed)";
    folders.push({ id: folder.id, name });
    if (folder.childFolderCount) {
      const children = await list(
        `/mailFolders/${encodeURIComponent(folder.id)}/childFolders`
      );
      for (const child of children) {
        folders.push({
          id: child.id,
          name: `${name} / ${child.displayName || "(unnamed)"}`,
        });
      }
    }
  }
  return { folders, inboxId: inbox?.id ?? null };
};
