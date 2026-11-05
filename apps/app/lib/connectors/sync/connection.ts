// A connection's stored tokens: loading, saving and refreshing them.

import "server-only";
import { database, forOrg, Prisma } from "@repo/database";
import { credentials, encryptionKey, type Provider } from "../config";
import { decrypt, encrypt } from "../crypto";
import { refreshTokens as refreshGmail } from "../gmail";
import { refreshTokens as refreshOutlook } from "../outlook";
import { refreshTokens as refreshQuickBooks } from "../quickbooks";

/** Refresh access tokens this long before they expire. */
export const REFRESH_EARLY_MS = 5 * 60_000;

export const DAY_MS = 86_400_000;

/** On a first mailbox check, look back this far for RFQs. */
export const FIRST_LOOK_BACK_DAYS = 3;

/** Earlier customer RFQs looked at for "known customers only". */
export const KNOWN_SENDER_RFQS = 500;

export interface SyncResult {
  created: number;
  notes: string[];
  skipped: number;
  updated: number;
}

export type ConnectionRow = NonNullable<
  Awaited<ReturnType<typeof loadConnection>>
>;

export const loadConnection = (orgId: string, provider: Provider) =>
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
export const accessToken = async (connection: ConnectionRow) => {
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
