import "server-only";

import { randomBytes } from "node:crypto";
import { database, forOrg, Prisma } from "@repo/database";
import { saveRecords } from "@repo/ingest/save";
import { log } from "@repo/observability/log";
import { budgetProblem } from "../ai-usage";
import { track } from "../analytics";
import { intakeRfq } from "../quotes/intake";
import { readRfqFile } from "../quotes/read";
import { checkSentReplies } from "../quotes/sent";
import { rfqLabel } from "../quotes/types";
import {
  credentials,
  encryptionKey,
  outlookNotificationUrl,
  type Provider,
} from "./config";
import { decrypt, encrypt } from "./crypto";
import {
  GmailAuthError,
  listMessages,
  previewMessages as previewGmail,
  rawMessageAndThread,
  refreshTokens as refreshGmail,
  revokeToken as revokeGmail,
  searchFor,
} from "./gmail";
import {
  createSubscription,
  DEFAULT_FOLDER,
  deleteSubscription,
  firstDeltaUrl,
  type GraphMessage,
  listFolders,
  type MicrosoftTokens,
  MAX_MESSAGES as OUTLOOK_MAX_MESSAGES,
  OutlookAuthError,
  OutlookDeltaExpired,
  type OutlookSubscription,
  rawMessage as outlookRawMessage,
  previewMessages as previewOutlook,
  readDelta,
  refreshTokens as refreshOutlook,
  renewSubscription,
  rfqMessages,
  subscriptionAction,
} from "./outlook";
import {
  customerRecords,
  ESTIMATE_YEARS,
  estimateRecords,
  QbAuthError,
  type QbCustomer,
  type QbEnvironment,
  type QbEstimate,
  type QbTerm,
  queryAll,
  refreshTokens as refreshQuickBooks,
  revokeToken as revokeQuickBooks,
} from "./quickbooks";
import {
  allowedSenders,
  gmailQuery,
  knownSenderRules,
  type RfqRules,
  readRules,
  senderPasses,
} from "./rfq-rules";
import { fingerprint, type MailThread } from "./thread";

/** Refresh access tokens this long before they expire. */
const REFRESH_EARLY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** On a first mailbox check, look back this far for RFQs. */
const FIRST_LOOK_BACK_DAYS = 3;
/** Earlier customer RFQs looked at for "known customers only". */
const KNOWN_SENDER_RFQS = 500;

export interface SyncResult {
  created: number;
  notes: string[];
  skipped: number;
  updated: number;
}

type ConnectionRow = NonNullable<Awaited<ReturnType<typeof loadConnection>>>;

const loadConnection = (orgId: string, provider: Provider) =>
  forOrg(database, orgId).connection.findFirst({ where: { provider } });

/** Save a new connection's tokens (encrypted), replacing an old one. */
export const saveConnection = async (
  orgId: string,
  provider: Provider,
  data: {
    accessToken: string;
    account: string;
    accountLabel: string | null;
    createdBy: string | null;
    expiresIn: number;
    refreshToken: string | null;
    scope?: string | null;
    /** Replaces the settings. */
    settings?: object;
    /** Settings for a first connection only; a reconnect keeps the old ones. */
    initialSettings?: object;
  }
) => {
  const key = encryptionKey();
  const fields = {
    status: "connected",
    account: data.account,
    accountLabel: data.accountLabel,
    accessToken: encrypt(key, data.accessToken),
    refreshToken: data.refreshToken ? encrypt(key, data.refreshToken) : null,
    expiresAt: new Date(Date.now() + data.expiresIn * 1000),
    scope: data.scope ?? null,
    lastError: null,
    createdBy: data.createdBy,
    ...(data.settings ? { settings: data.settings } : {}),
  };
  await database.connection.upsert({
    where: { orgId_provider: { orgId, provider } },
    create: {
      orgId,
      provider,
      ...fields,
      ...(data.initialSettings && !data.settings
        ? { settings: data.initialSettings }
        : {}),
    },
    update: { ...fields, lastSyncAt: null, lastResult: Prisma.DbNull },
  });
};

/** A usable access token, refreshing (and saving) it when it's about to expire. */
const accessToken = async (connection: ConnectionRow) => {
  const key = encryptionKey();
  const fresh =
    connection.expiresAt &&
    connection.expiresAt.getTime() - REFRESH_EARLY_MS > Date.now();
  if (fresh) {
    return decrypt(key, connection.accessToken);
  }
  const creds = credentials(connection.provider as Provider);
  if (!(creds && connection.refreshToken)) {
    throw new Error("The connection has expired. Reconnect it.");
  }
  const refreshToken = decrypt(key, connection.refreshToken);
  const refresh = {
    quickbooks: refreshQuickBooks,
    gmail: refreshGmail,
    outlook: refreshOutlook,
  }[connection.provider as Provider];
  const tokens = await refresh(fetch, creds, refreshToken);
  await database.connection.update({
    where: { id: connection.id },
    data: {
      accessToken: encrypt(key, tokens.access_token),
      // QuickBooks and Microsoft rotate refresh tokens; Google usually
      // keeps the old one.
      ...(tokens.refresh_token
        ? { refreshToken: encrypt(key, tokens.refresh_token) }
        : {}),
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
  });
  return tokens.access_token;
};

/**
 * A connected mailbox and a usable token, for writing reply drafts (F2.5).
 * Null when the shop hasn't connected it (or disconnected it).
 */
export const mailboxAccess = async (
  orgId: string,
  provider: "gmail" | "outlook"
) => {
  const connection = await loadConnection(orgId, provider);
  if (!connection || connection.status === "disconnected") {
    return null;
  }
  return { connection, token: await accessToken(connection) };
};

/** Customers and estimates from QuickBooks, through the shop data import. */
const syncQuickBooks = async (
  orgId: string,
  connection: ConnectionRow
): Promise<SyncResult> => {
  const creds = credentials("quickbooks");
  if (!creds) {
    throw new Error("QuickBooks isn't set up on this server.");
  }
  const token = await accessToken(connection);
  const env = creds.environment as QbEnvironment;
  const since = new Date(Date.now() - ESTIMATE_YEARS * 365 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const [customers, terms, estimates, parts] = await Promise.all([
    queryAll<QbCustomer>(fetch, env, connection.account, token, "Customer"),
    queryAll<QbTerm>(fetch, env, connection.account, token, "Term"),
    queryAll<QbEstimate>(
      fetch,
      env,
      connection.account,
      token,
      "Estimate",
      `TxnDate >= '${since}'`
    ),
    forOrg(database, orgId).part.findMany({ select: { partNo: true } }),
  ]);
  const a = await saveRecords(
    database,
    orgId,
    "customers",
    customerRecords(customers, terms)
  );
  const b = await saveRecords(
    database,
    orgId,
    "quotes",
    estimateRecords(
      estimates,
      parts.map((p) => p.partNo)
    )
  );
  return {
    created: a.created + b.created,
    updated: a.updated + b.updated,
    skipped: a.skipped + b.skipped,
    notes: [
      `${customers.length} customers and ${estimates.length} estimates read.`,
      ...a.notes,
      ...b.notes,
    ],
  };
};

/**
 * Who may send RFQs under the shop's rules (null: anyone). "Known customers"
 * are the senders of earlier RFQs that were linked to a customer.
 */
const senderFilter = async (orgId: string, rules: RfqRules) => {
  if (!rules.knownCustomersOnly) {
    return allowedSenders(rules, []);
  }
  const earlier = await forOrg(database, orgId).rfq.findMany({
    where: { customerId: { not: null }, sender: { not: null } },
    orderBy: { receivedAt: "desc" },
    take: KNOWN_SENDER_RFQS,
    select: { sender: true },
  });
  return allowedSenders(rules, knownSenderRules(earlier.map((r) => r.sender)));
};

/**
 * The same RFQ coming round again in a reply chain: an RFQ from the same
 * conversation with the same attachments is already in Takumo. Its number,
 * or null.
 */
const alreadyHave = async (orgId: string, mail: MailThread) => {
  if (!mail.threadId) {
    return null;
  }
  const found = await forOrg(database, orgId).rfq.findFirst({
    where: {
      AND: [
        { extracted: { path: ["mail", "threadId"], equals: mail.threadId } },
        {
          extracted: {
            path: ["mail", "attachmentsHash"],
            equals: mail.attachmentsHash,
          },
        },
      ],
    },
    select: { number: true },
  });
  return found?.number ?? null;
};

/** The sync note for an RFQ that's already in Takumo (same sender and files). */
const sameRfqNote = (
  text: { sender: string | null; subject: string | null },
  number: number
) =>
  `Skipped ${text.subject ?? "a message"} from ${text.sender ?? "an unknown sender"}: same sender and files as ${rfqLabel(number)}, received in the last week.`;

/** Why a fetched message isn't read into an RFQ, or null to read it. */
const skipReason = async (
  orgId: string,
  from: string | null,
  allowed: string[] | null,
  mail: MailThread
) => {
  if (!senderPasses(from, allowed)) {
    return `Skipped mail from ${from ?? "an unknown sender"}: not a sender your RFQ rules allow.`;
  }
  const number = await alreadyHave(orgId, mail);
  return number === null
    ? null
    : `Skipped a reply in the thread of RFQ #${number}: same attachments, so the same request.`;
};

/** New RFQ emails since the last check, each read into an RFQ once. */
const syncGmail = async (
  orgId: string,
  connection: ConnectionRow
): Promise<SyncResult> => {
  const token = await accessToken(connection);
  const settings = (connection.settings as { query?: string } | null) ?? {};
  const rules = readRules(connection.settings);
  const allowed = await senderFilter(orgId, rules);
  const since =
    connection.lastSyncAt ??
    new Date(Date.now() - FIRST_LOOK_BACK_DAYS * DAY_MS);
  const started = new Date();
  const ids = await listMessages(
    fetch,
    token,
    searchFor(gmailQuery(settings.query, rules), since)
  );
  const seen = new Set(
    (
      await forOrg(database, orgId).rfq.findMany({
        // Any channel: a portal or form email is still read once.
        where: { sourceId: { in: ids } },
        select: { sourceId: true },
      })
    ).map((r) => r.sourceId)
  );
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, notes: [] };
  let paused: string | null = null;
  // Oldest first, so RFQ numbers follow the order the mail arrived.
  for (const id of [...ids].reverse()) {
    if (seen.has(id)) {
      result.skipped += 1;
      continue;
    }
    // Reading an RFQ uses Claude: stop at the shop's monthly AI budget.
    paused = await budgetProblem(orgId);
    if (paused) {
      result.notes.push(paused);
      break;
    }
    try {
      const { bytes, threadId } = await rawMessageAndThread(fetch, token, id);
      const { from, attachmentsHash } = fingerprint(bytes);
      const mail: MailThread = { provider: "gmail", threadId, attachmentsHash };
      const skip = await skipReason(orgId, from, allowed, mail);
      if (skip) {
        result.skipped += 1;
        result.notes.push(skip);
        continue;
      }
      const text = await readRfqFile("message.eml", bytes);
      const rfq = await intakeRfq(orgId, connection.createdBy, text, {
        sourceId: id,
        mail,
      });
      if (rfq.duplicate) {
        result.skipped += 1;
        result.notes.push(sameRfqNote(text, rfq.number));
        continue;
      }
      track("rfq_received", {
        orgId,
        properties: { source: "gmail", channel: text.source },
      });
      result.created += 1;
      result.notes.push(
        `RFQ from ${text.sender ?? "an email"}: ${text.subject ?? "(no subject)"} (#${rfq.number})`
      );
    } catch (error) {
      result.skipped += 1;
      result.notes.push(
        `Couldn't read message ${id}: ${error instanceof Error ? error.message : "error"}`
      );
    }
  }
  if (paused) {
    // The rest are read on a later check, once there's budget again.
    return result;
  }
  // Next time, only mail that arrived after this check started.
  await database.connection.update({
    where: { id: connection.id },
    data: { lastSyncAt: started },
  });
  return result;
};

/** What an Outlook connection keeps in `Connection.settings`. */
interface OutlookSettings {
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

const outlookSettings = (settings: unknown): OutlookSettings =>
  settings && typeof settings === "object" ? (settings as OutlookSettings) : {};

// Settings as a JSON object even if the column holds null.
const SETTINGS = Prisma.sql`(CASE WHEN jsonb_typeof(settings) = 'object' THEN settings ELSE '{}'::jsonb END)`;

/**
 * Merge keys into a connection's settings in one statement, so a check saving
 * its delta link can't wipe a change made meanwhile (and the reverse).
 */
const mergeSettings = (id: string, patch: Partial<OutlookSettings>) =>
  database.$executeRaw`UPDATE "Connection" SET settings = ${SETTINGS} || ${JSON.stringify(patch)}::jsonb, "updatedAt" = now() WHERE id = ${id}`;

/** A check can't take longer than a function runs (maxDuration 300 s). */
const LOCK_MS = 5 * 60_000;
const MAX_ROUNDS = 3;

const claimLock = async (id: string) =>
  (await database.$executeRaw`UPDATE "Connection" SET settings = ${SETTINGS} || jsonb_build_object('lockedUntil', ${Date.now() + LOCK_MS}::bigint, 'pending', false) WHERE id = ${id} AND COALESCE((settings->>'lockedUntil')::bigint, 0) < ${Date.now()}::bigint`) ===
  1;

/** Unlock, unless mail arrived during the check (then the caller goes again). */
const releaseLock = async (id: string, force = false) =>
  force
    ? (await mergeSettings(id, { lockedUntil: 0, pending: false })) === 1
    : (await database.$executeRaw`UPDATE "Connection" SET settings = ${SETTINGS} || '{"lockedUntil": 0}'::jsonb WHERE id = ${id} AND COALESCE((settings->>'pending')::boolean, false) = false`) ===
      1;

/**
 * Keep the new-mail subscription alive: create it after connecting (or if
 * Microsoft dropped it), renew it when under a day is left, remove it for a
 * shared mailbox. Returns a note when instant notifications aren't on.
 */
const keepSubscription = async (
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
const deltaKey = (settings: OutlookSettings) => {
  const mailbox = settings.sharedMailbox || "me";
  return settings.folderId ? `${mailbox}#${settings.folderId}` : mailbox;
};

/**
 * This check's delta round: from the saved position, or (first check, new
 * mailbox, or a position Graph forgot) new mail since the last check.
 */
const outlookRound = async (
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
 * budget. Returns whether it stopped early.
 */
const readOutlookRfqs = async (
  orgId: string,
  connection: ConnectionRow,
  token: string,
  messages: GraphMessage[],
  shared: string | null,
  result: SyncResult
) => {
  for (const message of messages) {
    // Reading an RFQ uses AI: stop at the shop's monthly budget.
    const paused = await budgetProblem(orgId);
    if (paused) {
      result.notes.push(paused);
      return true;
    }
    try {
      const bytes = await outlookRawMessage(fetch, token, message.id, shared);
      const mail: MailThread = {
        provider: "outlook",
        threadId: message.conversationId ?? null,
        attachmentsHash: fingerprint(bytes).attachmentsHash,
      };
      // Senders were already checked on the message list (rfqMessages).
      const skip = await skipReason(orgId, null, null, mail);
      if (skip) {
        result.skipped += 1;
        result.notes.push(skip);
        continue;
      }
      const text = await readRfqFile("message.eml", bytes);
      const rfq = await intakeRfq(orgId, connection.createdBy, text, {
        sourceId: message.id,
        mail,
      });
      if (rfq.duplicate) {
        result.skipped += 1;
        result.notes.push(sameRfqNote(text, rfq.number));
        continue;
      }
      track("rfq_received", {
        orgId,
        properties: { source: "outlook", channel: text.source },
      });
      result.created += 1;
      result.notes.push(
        `RFQ from ${text.sender ?? "an email"}: ${text.subject ?? "(no subject)"} (#${rfq.number})`
      );
    } catch (error) {
      result.skipped += 1;
      result.notes.push(
        `Couldn't read "${message.subject ?? "(no subject)"}": ${error instanceof Error ? error.message : "error"}`
      );
    }
  }
  return false;
};

/** New RFQ emails in the Outlook RFQ folder since the last delta round. */
const syncOutlook = async (
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
  const seen = new Set(
    (
      await forOrg(database, orgId).rfq.findMany({
        where: { sourceId: { in: candidates.map((m) => m.id) } },
        select: { sourceId: true },
      })
    ).map((r) => r.sourceId)
  );
  const fresh = candidates.filter((m) => !seen.has(m.id));
  result.skipped += candidates.length - fresh.length;
  const paused = await readOutlookRfqs(
    orgId,
    connection,
    token,
    fresh.slice(0, OUTLOOK_MAX_MESSAGES),
    shared,
    result
  );
  if (paused || fresh.length > OUTLOOK_MAX_MESSAGES || !round.deltaLink) {
    // Keep the old position: the rest are read on a later check (the ones
    // already read are skipped by message id).
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
    const auth =
      error instanceof QbAuthError ||
      error instanceof GmailAuthError ||
      error instanceof OutlookAuthError;
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
