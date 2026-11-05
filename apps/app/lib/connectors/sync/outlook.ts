// Outlook sync: delta rounds under a lock, and keeping the notification subscription alive.

import "server-only";

import { randomBytes } from "node:crypto";
import { database, Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { budgetProblem } from "../../ai-usage";
import { encryptionKey, outlookNotificationUrl } from "../config";
import { encrypt } from "../crypto";
import {
  createSubscription,
  DEFAULT_FOLDER,
  deleteSubscription,
  firstDeltaUrl,
  type GraphMessage,
  MAX_MESSAGES as OUTLOOK_MAX_MESSAGES,
  OutlookDeltaExpired,
  type OutlookSubscription,
  rawMessage as outlookRawMessage,
  readDelta,
  renewSubscription,
  rfqMessages,
  subscriptionAction,
} from "../outlook";
import { type RfqRules, readRules } from "../rfq-rules";
import {
  accessToken,
  type ConnectionRow,
  DAY_MS,
  FIRST_LOOK_BACK_DAYS,
  type SyncResult,
} from "./connection";
import { intakeMessage, seenMessages, senderFilter } from "./intake";

/** What an Outlook connection keeps in `Connection.settings`. */
export interface OutlookSettings {
  /** Where the next delta round starts, and which mailbox it belongs to. */
  deltaFor?: string | null;
  deltaLink?: string | null;
  /** Read RFQs from this folder (null: the Inbox), and its name to show. */
  folderId?: string | null;
  folderName?: string | null;
  /** Lock against two checks reading the same mail at once (epoch ms). */
  lockedUntil?: number;
  /** A notification arrived while a check was running: check again. */
  pending?: boolean;
  rfqRules?: RfqRules;
  /** Read RFQs from this shared mailbox instead of the person's own. */
  sharedMailbox?: string | null;
  subscription?: OutlookSubscription | null;
}

export const outlookSettings = (settings: unknown): OutlookSettings =>
  settings && typeof settings === "object" ? (settings as OutlookSettings) : {};

// Settings as a JSON object even if the column holds null.
export const SETTINGS = Prisma.sql`(CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END)`;

/**
 * Merge keys into a connection's settings in one statement, so a check saving
 * its delta link can't wipe a change made meanwhile (and the reverse).
 */
export const mergeSettings = (id: string, patch: Partial<OutlookSettings>) =>
  database.$executeRaw`UPDATE "Connection" SET settings = ${SETTINGS} || ${JSON.stringify(patch)}::jsonb, "updatedAt" = now() WHERE id = ${id}`;

/** A check can't take longer than a function runs (maxDuration 300 s). */
export const LOCK_MS = 5 * 60_000;

export const MAX_ROUNDS = 3;

export const claimLock = async (id: string) =>
  (await database.$executeRaw`UPDATE "Connection" SET settings = ${SETTINGS} || jsonb_build_object('lockedUntil', ${Date.now() + LOCK_MS}::bigint, 'pending', false) WHERE id = ${id} AND COALESCE((settings->>'lockedUntil')::bigint, 0) < ${Date.now()}::bigint`) ===
  1;

/** Unlock, unless mail arrived during the check (then the caller goes again). */
export const releaseLock = async (id: string, force = false) =>
  force
    ? (await mergeSettings(id, { lockedUntil: 0, pending: false })) === 1
    : (await database.$executeRaw`UPDATE "Connection" SET settings = ${SETTINGS} || '{"lockedUntil": 0}'::jsonb WHERE id = ${id} AND COALESCE((settings->>'pending')::boolean, false) = false`) ===
      1;

/**
 * Keep the new-mail subscription alive: create it after connecting (or if
 * Microsoft dropped it), renew it when under a day is left, remove it for a
 * shared mailbox. Returns a note when instant notifications aren't on.
 */
export const keepSubscription = async (
  connection: ConnectionRow,
  settings: OutlookSettings,
  token: string
): Promise<string | null> => {
  const url = outlookNotificationUrl();
  let current = settings.subscription ?? null;
  const folder = settings.folderId || DEFAULT_FOLDER;
  if (current && (current.folder || DEFAULT_FOLDER) !== folder) {
    // Watching the old folder: replace it with one on the chosen folder.
    await deleteSubscription(fetch, token, current.id).catch(() => null);
    await mergeSettings(connection.id, { subscription: null });
    current = null;
  }
  const action = subscriptionAction(current, {
    canNotify: url !== null,
    sharedMailbox: settings.sharedMailbox,
  });
  if (action === "keep") {
    return null;
  }
  if (action === "remove" && current) {
    await deleteSubscription(fetch, token, current.id).catch(() => null);
    await mergeSettings(connection.id, { subscription: null });
    return null;
  }
  if (action === "renew" && current) {
    const expiresAt = await renewSubscription(fetch, token, current.id);
    if (expiresAt) {
      await mergeSettings(connection.id, {
        subscription: { ...current, expiresAt },
      });
      return null;
    }
  }
  if (!url) {
    return null;
  }
  // Random per subscription; stored sealed, compared on every notification.
  const clientState = randomBytes(32).toString("base64url");
  const created = await createSubscription(
    fetch,
    token,
    url,
    clientState,
    Date.now(),
    folder
  );
  await mergeSettings(connection.id, {
    subscription: {
      id: created.id,
      expiresAt: created.expiresAt,
      clientState: encrypt(encryptionKey(), clientState),
      folder,
    },
  });
  return null;
};

/** Which mailbox and folder a saved delta position belongs to. */
export const deltaKey = (settings: OutlookSettings) => {
  const mailbox = settings.sharedMailbox || "me";
  return settings.folderId ? `${mailbox}#${settings.folderId}` : mailbox;
};

/**
 * This check's delta round: from the saved position, or (first check, new
 * mailbox, or a position Graph forgot) new mail since the last check.
 */
export const outlookRound = async (
  connection: ConnectionRow,
  settings: OutlookSettings,
  token: string
) => {
  const shared = settings.sharedMailbox || null;
  const since =
    connection.lastSyncAt ??
    new Date(Date.now() - FIRST_LOOK_BACK_DAYS * DAY_MS);
  const first = firstDeltaUrl(shared, since, settings.folderId);
  const saved =
    settings.deltaLink && settings.deltaFor === deltaKey(settings)
      ? settings.deltaLink
      : null;
  try {
    return await readDelta(fetch, token, saved ?? first, shared);
  } catch (error) {
    if (!(saved && error instanceof OutlookDeltaExpired)) {
      throw error;
    }
    // De-duplication by message id skips what was read before.
    return readDelta(fetch, token, first, shared);
  }
};

/**
 * Read each message into an RFQ, oldest first, stopping at the shop's AI
 * budget. Returns whether to keep the old delta position: it stopped early,
 * or Outlook didn't hand over a message (a 429 or 5xx), which the next check
 * must see again.
 */
export const readOutlookRfqs = async (
  orgId: string,
  connection: ConnectionRow,
  token: string,
  messages: GraphMessage[],
  shared: string | null,
  result: SyncResult
) => {
  let unfetched = false;
  for (const message of messages) {
    // Reading an RFQ uses AI: stop at the shop's monthly budget.
    const paused = await budgetProblem(orgId);
    if (paused) {
      result.notes.push(paused);
      return true;
    }
    let bytes: Uint8Array;
    try {
      bytes = await outlookRawMessage(fetch, token, message.id, shared);
    } catch (error) {
      unfetched = true;
      result.skipped += 1;
      result.notes.push(
        `Couldn't fetch "${message.subject ?? "(no subject)"}" (will try again): ${error instanceof Error ? error.message : "error"}`
      );
      continue;
    }
    // Senders were already checked on the message list (rfqMessages).
    await intakeMessage(
      orgId,
      connection,
      "outlook",
      {
        id: message.id,
        bytes,
        threadId: message.conversationId ?? null,
        allowed: null,
        label: `"${message.subject ?? "(no subject)"}"`,
        mailbox: shared ?? connection.account,
      },
      result
    );
  }
  return unfetched;
};

/** New RFQ emails in the Outlook RFQ folder since the last delta round. */
export const syncOutlook = async (
  orgId: string,
  connection: ConnectionRow
): Promise<SyncResult> => {
  const token = await accessToken(connection);
  const settings = outlookSettings(connection.settings);
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, notes: [] };
  try {
    await keepSubscription(connection, settings, token);
  } catch (error) {
    // Not fatal: the hourly check still finds every RFQ.
    log.warn("Outlook subscription failed", { orgId, error: String(error) });
    result.notes.push(
      "New mail is checked every hour; instant notifications couldn't be turned on."
    );
  }
  const shared = settings.sharedMailbox || null;
  const started = new Date();
  const round = await outlookRound(connection, settings, token);
  const rules = readRules(connection.settings);
  const candidates = rfqMessages(
    round.messages,
    shared ?? connection.account,
    rules,
    await senderFilter(orgId, rules)
  );
  const seen = await seenMessages(
    orgId,
    candidates.map((m) => m.id)
  );
  const fresh = candidates.filter((m) => !seen.has(m.id));
  result.skipped += candidates.length - fresh.length;
  const keepPosition = await readOutlookRfqs(
    orgId,
    connection,
    token,
    fresh.slice(0, OUTLOOK_MAX_MESSAGES),
    shared,
    result
  );
  if (keepPosition || fresh.length > OUTLOOK_MAX_MESSAGES || !round.deltaLink) {
    // Keep the old position: the rest (and any message Outlook didn't hand
    // over) are read on a later check; the ones already read are skipped by
    // message id.
    return result;
  }
  await mergeSettings(connection.id, {
    deltaLink: round.deltaLink,
    deltaFor: deltaKey(settings),
  });
  await database.connection.update({
    where: { id: connection.id },
    data: { lastSyncAt: started },
  });
  return result;
};
