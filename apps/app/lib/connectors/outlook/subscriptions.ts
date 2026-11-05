// Change notifications, so new mail arrives within a minute or two.

import { timingSafeEqual } from "node:crypto";
import { SINGLE_QUOTE } from "./auth";
import {
  type Fetch,
  graph,
  json,
  RENEW_WITHIN_MS,
  SUBSCRIPTION_MINUTES,
} from "./graph";
import { DEFAULT_FOLDER } from "./mail";

export interface OutlookSubscription {
  /** AES-GCM sealed (see crypto.ts): proves a notification is from Graph. */
  clientState: string;
  expiresAt: string;
  /** The folder it watches (missing on older ones: the Inbox). */
  folder?: string | null;
  id: string;
}

/** Subscriptions belong to the signed-in mailbox only (a Graph rule). */
export const SUBSCRIPTION_RESOURCE = "/me/mailFolders('inbox')/messages";

/** What a subscription watches: the RFQ folder of the signed-in mailbox. */
export const subscriptionResource = (folder?: string | null) =>
  !folder || folder === DEFAULT_FOLDER
    ? SUBSCRIPTION_RESOURCE
    : `/me/mailFolders('${folder.replace(SINGLE_QUOTE, "''")}')/messages`;

export const subscriptionExpiry = (now = Date.now()) =>
  new Date(now + SUBSCRIPTION_MINUTES * 60_000).toISOString();

export type SubscriptionAction = "create" | "keep" | "remove" | "renew";

/**
 * What to do with the notification subscription on a check. Delegated access
 * can't subscribe to a shared mailbox, so those rely on the hourly check.
 */
export const subscriptionAction = (
  current: Pick<OutlookSubscription, "expiresAt"> | null | undefined,
  options: { canNotify: boolean; sharedMailbox?: string | null },
  now = Date.now()
): SubscriptionAction => {
  if (!options.canNotify || options.sharedMailbox) {
    return current ? "remove" : "keep";
  }
  if (!current) {
    return "create";
  }
  const left = Date.parse(current.expiresAt) - now;
  if (!(left > 0)) {
    // Expired subscriptions are gone at Microsoft's end: make a new one.
    return "create";
  }
  return left < RENEW_WITHIN_MS ? "renew" : "keep";
};

/** A new subscription; Graph checks the notification URL before answering. */
export const createSubscription = async (
  fetcher: Fetch,
  accessToken: string,
  notificationUrl: string,
  clientState: string,
  now = Date.now(),
  folder?: string | null
) => {
  const created = await json<{ expirationDateTime: string; id: string }>(
    await graph(fetcher, accessToken, "/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        changeType: "created",
        notificationUrl,
        resource: subscriptionResource(folder),
        expirationDateTime: subscriptionExpiry(now),
        clientState,
      }),
    })
  );
  return { id: created.id, expiresAt: created.expirationDateTime };
};

/** A later expiry for a subscription, or null when it no longer exists. */
export const renewSubscription = async (
  fetcher: Fetch,
  accessToken: string,
  id: string,
  now = Date.now()
) => {
  const response = await graph(
    fetcher,
    accessToken,
    `/subscriptions/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expirationDateTime: subscriptionExpiry(now) }),
    }
  );
  if (response.status === 404) {
    return null;
  }
  return (await json<{ expirationDateTime: string }>(response))
    .expirationDateTime;
};

export const deleteSubscription = async (
  fetcher: Fetch,
  accessToken: string,
  id: string
) => {
  const response = await graph(
    fetcher,
    accessToken,
    `/subscriptions/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  // Already gone is as good as deleted.
  if (!(response.ok || response.status === 404)) {
    throw new Error(`Microsoft Graph returned an error (${response.status}).`);
  }
};

/** Constant-time comparison of a notification's clientState with ours. */
export const sameSecret = (expected: string, given: unknown) => {
  if (typeof given !== "string") {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

export interface Notification {
  clientState?: unknown;
  subscriptionId?: unknown;
}

/**
 * Graph's POST to the notification URL. On creating a subscription it sends
 * `?validationToken=…`, which must come straight back as plain text within 10
 * seconds; after that, notifications must be acknowledged within 3 seconds,
 * so the check itself runs after the response (`schedule`).
 */
export const handleNotification = async (
  request: Request,
  deps: {
    /** The org and plain clientState for a subscription id, if it's ours. */
    lookup: (
      subscriptionId: string
    ) => Promise<{ clientState: string; orgId: string } | null>;
    schedule: (orgIds: string[]) => void;
  }
) => {
  const token = new URL(request.url).searchParams.get("validationToken");
  if (token !== null) {
    return new Response(token, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  let body: { value?: Notification[] };
  try {
    body = (await request.json()) as { value?: Notification[] };
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const orgIds = new Set<string>();
  for (const n of Array.isArray(body.value) ? body.value : []) {
    if (typeof n.subscriptionId !== "string") {
      continue;
    }
    const target = await deps.lookup(n.subscriptionId);
    // A wrong clientState isn't from Graph: ignore it.
    if (target && sameSecret(target.clientState, n.clientState)) {
      orgIds.add(target.orgId);
    }
  }
  if (orgIds.size) {
    deps.schedule([...orgIds]);
  }
  return new Response(null, { status: 202 });
};
