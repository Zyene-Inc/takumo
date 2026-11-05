import "server-only";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { track } from "../../analytics";
import { checkSentReplies } from "../../quotes/sent";
import { credentials, encryptionKey, type Provider } from "../config";
import { decrypt } from "../crypto";
import {
  GmailAuthError,
  previewMessages as previewGmail,
  revokeToken as revokeGmail,
} from "../gmail";
import {
  deleteSubscription,
  listFolders,
  type MicrosoftTokens,
  OutlookAuthError,
  OutlookConsentError,
  OutlookMailboxError,
  previewMessages as previewOutlook,
} from "../outlook";
import { QbAuthError, revokeToken as revokeQuickBooks } from "../quickbooks";
import { gmailQuery, type RfqRules, readRules } from "../rfq-rules";
import {
  accessToken,
  type ConnectionRow,
  loadConnection,
  type SyncResult,
  saveConnection,
} from "./connection";
import { syncGmail } from "./gmail";
import { senderFilter } from "./intake";
import {
  claimLock,
  LOCK_MS,
  MAX_ROUNDS,
  mergeSettings,
  outlookSettings,
  releaseLock,
  SETTINGS,
  syncOutlook,
} from "./outlook";
import { syncQuickBooks } from "./quickbooks";

export { mailboxAccess, saveConnection } from "./connection";

/** One sync, with how it went saved on the connection. */
const runSync = async (
  orgId: string,
  provider: Provider,
  connection: ConnectionRow
) => {
  try {
    const sync = {
      quickbooks: syncQuickBooks,
      gmail: syncGmail,
      outlook: syncOutlook,
    }[provider];
    const result = await sync(orgId, connection);
    if (provider !== "quickbooks") {
      // Replies the estimator sent from this mailbox since the last check.
      result.notes.push(
        ...(await checkSentReplies(orgId, provider, connection, async () => {
          // Reloaded: the sync may have refreshed (and rotated) the tokens.
          const current = await loadConnection(orgId, provider);
          return accessToken(current ?? connection);
        }))
      );
    }
    await database.connection.update({
      where: { id: connection.id },
      data: {
        status: "connected",
        lastError: null,
        lastResult: result as object,
        ...(provider === "quickbooks" ? { lastSyncAt: new Date() } : {}),
      },
    });
    track("connector_synced", {
      orgId,
      properties: {
        provider,
        created: result.created,
        updated: result.updated,
      },
    });
    return { ok: true as const, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The sync failed.";
    log.warn("Connector sync failed", { orgId, provider, error: message });
    // Errors only a person can fix (sign in again, an admin re-grants
    // consent, access to the shared mailbox restored): the connection shows
    // as broken and the daily health email names it.
    const auth =
      error instanceof QbAuthError ||
      error instanceof GmailAuthError ||
      error instanceof OutlookAuthError ||
      error instanceof OutlookConsentError ||
      error instanceof OutlookMailboxError;
    await database.connection.update({
      where: { id: connection.id },
      data: { status: auth ? "error" : connection.status, lastError: message },
    });
    return { ok: false as const, error: message };
  }
};

/** Run one connection's sync and record how it went. */
export const syncConnection = async (orgId: string, provider: Provider) => {
  const connection = await loadConnection(orgId, provider);
  if (!connection || connection.status === "disconnected") {
    return { ok: false as const, error: "Not connected." };
  }
  if (provider !== "outlook") {
    return runSync(orgId, provider, connection);
  }
  // Outlook checks start from notifications as well as the cron, often a few
  // at once: one runs, and the others ask it to go round again.
  if (!(await claimLock(connection.id))) {
    await mergeSettings(connection.id, { pending: true });
    return {
      ok: true as const,
      result: {
        created: 0,
        updated: 0,
        skipped: 0,
        notes: ["A check is already running; it picks up new mail too."],
      } satisfies SyncResult,
    };
  }
  // Once unlocked, another check may hold the lock: never unlock twice.
  let released = false;
  try {
    for (let round = 1; ; round += 1) {
      const current = await loadConnection(orgId, provider);
      if (!current) {
        return { ok: false as const, error: "Not connected." };
      }
      const outcome = await runSync(orgId, provider, current);
      released = await releaseLock(connection.id, round >= MAX_ROUNDS);
      if (released) {
        return outcome;
      }
      await mergeSettings(connection.id, {
        pending: false,
        lockedUntil: Date.now() + LOCK_MS,
      });
    }
  } finally {
    if (!released) {
      await releaseLock(connection.id, true).catch(() => null);
    }
  }
};

/** Save a new Outlook connection, replacing the old one and its subscription. */
export const connectOutlook = async (
  orgId: string,
  userId: string,
  account: string,
  tokens: MicrosoftTokens
) => {
  const old = await loadConnection(orgId, "outlook");
  const settings = outlookSettings(old?.settings);
  if (settings.subscription) {
    // Best effort: it may belong to another person's sign-in.
    await deleteSubscription(
      fetch,
      tokens.access_token,
      settings.subscription.id
    ).catch(() => null);
  }
  await saveConnection(orgId, "outlook", {
    account,
    accountLabel: account,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresIn: tokens.expires_in,
    scope: tokens.scope ?? null,
    createdBy: userId,
    // The same person reconnecting keeps their mailbox and folder choice;
    // the shop's RFQ rules stay whoever connects.
    settings: {
      ...(old?.account === account
        ? {
            sharedMailbox: settings.sharedMailbox ?? null,
            folderId: settings.folderId ?? null,
            folderName: settings.folderName ?? null,
          }
        : { sharedMailbox: null }),
      ...(settings.rfqRules ? { rfqRules: settings.rfqRules } : {}),
    },
  });
};

/**
 * Read RFQs from a shared mailbox (or, with null, the person's own), starting
 * fresh there; the caller runs a check to confirm access.
 */
export const setOutlookMailbox = async (
  orgId: string,
  sharedMailbox: string | null
) => {
  const connection = await loadConnection(orgId, "outlook");
  if (!connection) {
    return false;
  }
  await mergeSettings(connection.id, {
    sharedMailbox,
    // Folders belong to a mailbox: back to its Inbox.
    folderId: null,
    folderName: null,
    deltaLink: null,
    deltaFor: null,
  });
  await database.connection.update({
    where: { id: connection.id },
    data: { lastSyncAt: null },
  });
  return true;
};

/** The connected mailbox's folders, for choosing where RFQs land. */
export const outlookFolders = async (orgId: string) => {
  const connection = await loadConnection(orgId, "outlook");
  if (!connection || connection.status === "disconnected") {
    throw new Error("Outlook isn't connected.");
  }
  const shared = outlookSettings(connection.settings).sharedMailbox || null;
  return listFolders(fetch, await accessToken(connection), shared);
};

/**
 * Read RFQs from another folder (null: the Inbox), starting fresh there; the
 * next check moves the new-mail notifications to it as well.
 */
export const setOutlookFolder = async (
  orgId: string,
  folder: { id: string; name: string } | null
) => {
  const connection = await loadConnection(orgId, "outlook");
  if (!connection) {
    return false;
  }
  await mergeSettings(connection.id, {
    folderId: folder?.id ?? null,
    folderName: folder?.name ?? null,
    deltaLink: null,
    deltaFor: null,
  });
  await database.connection.update({
    where: { id: connection.id },
    data: { lastSyncAt: null },
  });
  return true;
};

/** Save a mailbox connection's RFQ rules, keeping its other settings. */
export const setRfqRules = async (
  orgId: string,
  provider: "gmail" | "outlook",
  rules: RfqRules
) => {
  const connection = await loadConnection(orgId, provider);
  if (!connection) {
    return false;
  }
  await mergeSettings(connection.id, { rfqRules: rules });
  return true;
};

/** Save Gmail's own RFQ search, keeping its other settings (the rules). */
export const setGmailQuery = async (orgId: string, query: string) => {
  const connection = await loadConnection(orgId, "gmail");
  if (!connection) {
    return false;
  }
  await database.$executeRaw`UPDATE "Connection" SET settings = ${SETTINGS} || jsonb_build_object('query', ${query}::text), "updatedAt" = now() WHERE id = ${connection.id}`;
  return true;
};

/** The org whose subscription this is, and its clientState, if it's ours. */
export const outlookSubscriber = async (subscriptionId: string) => {
  const connection = await database.connection.findFirst({
    where: {
      provider: "outlook",
      status: "connected",
      settings: { path: ["subscription", "id"], equals: subscriptionId },
    },
    select: { orgId: true, settings: true },
  });
  const sealed = outlookSettings(connection?.settings).subscription
    ?.clientState;
  if (!(connection && sealed)) {
    return null;
  }
  try {
    return {
      orgId: connection.orgId,
      clientState: decrypt(encryptionKey(), sealed),
    };
  } catch {
    return null;
  }
};

/** The last 20 emails and which would become RFQs; nothing is imported. */
export const previewConnection = async (
  orgId: string,
  provider: "gmail" | "outlook"
) => {
  const connection = await loadConnection(orgId, provider);
  if (!connection || connection.status === "disconnected") {
    throw new Error("Not connected.");
  }
  const token = await accessToken(connection);
  const rules = readRules(connection.settings);
  const allowed = await senderFilter(orgId, rules);
  if (provider === "gmail") {
    const { query } = (connection.settings as { query?: string } | null) ?? {};
    return previewGmail(fetch, token, gmailQuery(query, rules), allowed);
  }
  const settings = outlookSettings(connection.settings);
  const shared = settings.sharedMailbox || null;
  return previewOutlook(fetch, token, shared ?? connection.account, shared, {
    folder: settings.folderId,
    rules,
    allowed,
  });
};

/** Disconnect: revoke the tokens with the provider and forget them. */
export const disconnect = async (orgId: string, provider: Provider) => {
  const connection = await loadConnection(orgId, provider);
  if (!connection) {
    return;
  }
  const creds = credentials(provider);
  try {
    const key = encryptionKey();
    if (provider === "outlook") {
      // Microsoft has no per-app token revocation: stop the notifications,
      // then forgetting the tokens below is what disconnects.
      const subscription = outlookSettings(connection.settings).subscription;
      if (subscription) {
        await deleteSubscription(
          fetch,
          await accessToken(connection),
          subscription.id
        );
      }
    }
    const token = decrypt(
      key,
      connection.refreshToken ?? connection.accessToken
    );
    if (provider === "quickbooks" && creds) {
      await revokeQuickBooks(fetch, creds, token);
    } else if (provider === "gmail") {
      await revokeGmail(fetch, token);
    }
  } catch (error) {
    // Forget the tokens even if the provider can't be reached.
    log.warn("Revoking connector tokens failed", {
      orgId,
      provider,
      error: String(error),
    });
  }
  await database.connection.deleteMany({ where: { orgId, provider } });
};
