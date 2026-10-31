import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { saveRecords } from "@repo/ingest/save";
import { log } from "@repo/observability/log";
import { budgetProblem } from "../ai-usage";
import { track } from "../analytics";
import { intakeRfq } from "../quotes/intake";
import { readRfqFile } from "../quotes/read";
import { credentials, encryptionKey, type Provider } from "./config";
import { decrypt, encrypt } from "./crypto";
import {
  GmailAuthError,
  listMessages,
  rawMessage,
  refreshTokens as refreshGmail,
  revokeToken as revokeGmail,
  searchFor,
} from "./gmail";
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

/** Refresh access tokens this long before they expire. */
const REFRESH_EARLY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** On a first Gmail check, look back this far for RFQs. */
const FIRST_LOOK_BACK_DAYS = 3;

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
    settings?: object;
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
    create: { orgId, provider, ...fields },
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
  const tokens =
    connection.provider === "quickbooks"
      ? await refreshQuickBooks(fetch, creds, refreshToken)
      : await refreshGmail(fetch, creds, refreshToken);
  await database.connection.update({
    where: { id: connection.id },
    data: {
      accessToken: encrypt(key, tokens.access_token),
      // QuickBooks rotates refresh tokens; Google usually keeps the old one.
      ...(tokens.refresh_token
        ? { refreshToken: encrypt(key, tokens.refresh_token) }
        : {}),
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    },
  });
  return tokens.access_token;
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

/** New RFQ emails since the last check, each read into an RFQ once. */
const syncGmail = async (
  orgId: string,
  connection: ConnectionRow
): Promise<SyncResult> => {
  const token = await accessToken(connection);
  const settings = (connection.settings as { query?: string } | null) ?? {};
  const since =
    connection.lastSyncAt ??
    new Date(Date.now() - FIRST_LOOK_BACK_DAYS * DAY_MS);
  const started = new Date();
  const ids = await listMessages(
    fetch,
    token,
    searchFor(settings.query, since)
  );
  const seen = new Set(
    (
      await forOrg(database, orgId).rfq.findMany({
        where: { source: "email", sourceId: { in: ids } },
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
      const text = await readRfqFile(
        "message.eml",
        await rawMessage(fetch, token, id)
      );
      const rfq = await intakeRfq(orgId, connection.createdBy, text, null, id);
      track("rfq_received", { orgId, properties: { source: "gmail" } });
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

/** Run one connection's sync and record how it went. */
export const syncConnection = async (orgId: string, provider: Provider) => {
  const connection = await loadConnection(orgId, provider);
  if (!connection || connection.status === "disconnected") {
    return { ok: false as const, error: "Not connected." };
  }
  try {
    const result =
      provider === "quickbooks"
        ? await syncQuickBooks(orgId, connection)
        : await syncGmail(orgId, connection);
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
      error instanceof QbAuthError || error instanceof GmailAuthError;
    await database.connection.update({
      where: { id: connection.id },
      data: { status: auth ? "error" : connection.status, lastError: message },
    });
    return { ok: false as const, error: message };
  }
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
