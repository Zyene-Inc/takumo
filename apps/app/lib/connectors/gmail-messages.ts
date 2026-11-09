import { DEFAULT_RFQ_QUERY, type Fetch, get } from "./gmail-auth";
import { type PreviewMessage, senderPasses } from "./rfq-rules";

const MAX_MESSAGES = 20;

/** Ids of messages matching the search, newest first. */
export const listMessages = async (
  fetcher: Fetch,
  accessToken: string,
  q: string
): Promise<string[]> =>
  (
    (
      await get<{ messages?: { id: string }[] }>(
        fetcher,
        accessToken,
        `/messages?${new URLSearchParams({ q, maxResults: String(MAX_MESSAGES) })}`
      )
    ).messages ?? []
  ).map((m) => m.id);

/** The message as an .eml file (RFC 822 bytes), and its Gmail thread. */
export const rawMessageAndThread = async (
  fetcher: Fetch,
  accessToken: string,
  id: string
) => {
  const { raw, threadId } = await get<{ raw: string; threadId?: string }>(
    fetcher,
    accessToken,
    `/messages/${encodeURIComponent(id)}?format=raw`
  );
  return {
    bytes: new Uint8Array(Buffer.from(raw, "base64url")),
    threadId: threadId ?? null,
  };
};

/** The message as an .eml file (RFC 822 bytes). */
export const rawMessage = async (
  fetcher: Fetch,
  accessToken: string,
  id: string
) => (await rawMessageAndThread(fetcher, accessToken, id)).bytes;

interface GmailHeaders {
  payload?: { headers?: { name: string; value: string }[] };
}

const header = (message: GmailHeaders, name: string) =>
  message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value ?? null;

/**
 * The last 20 emails in the mailbox, each marked whether the shop's RFQ
 * search and sender rules pick it up. Reads headers only; nothing is imported.
 */
export const previewMessages = async (
  fetcher: Fetch,
  accessToken: string,
  query: string | null | undefined,
  /** The rules' sender filter (null: anyone). */
  allowed: string[] | null = null
): Promise<PreviewMessage[]> => {
  const [recent, matching] = await Promise.all([
    listMessages(fetcher, accessToken, "-in:sent -in:chats -in:drafts"),
    // Any of the last 20 that matches is among the 20 newest matches.
    listMessages(fetcher, accessToken, query?.trim() || DEFAULT_RFQ_QUERY),
  ]);
  const rfqs = new Set(matching);
  return Promise.all(
    recent.map(async (id) => {
      const params = new URLSearchParams({ format: "metadata" });
      for (const name of ["Subject", "From", "Date"]) {
        params.append("metadataHeaders", name);
      }
      const message = await get<GmailHeaders>(
        fetcher,
        accessToken,
        `/messages/${encodeURIComponent(id)}?${params}`
      );
      const date = header(message, "Date");
      const received = date ? new Date(date) : null;
      const from = header(message, "From");
      return {
        id,
        subject: header(message, "Subject"),
        from,
        receivedAt:
          received && !Number.isNaN(received.getTime())
            ? received.toISOString()
            : null,
        isRfq: rfqs.has(id) && senderPasses(from, allowed),
      };
    })
  );
};

/** RFC 2047 for a header that isn't plain ASCII (e.g. an accented subject). */
