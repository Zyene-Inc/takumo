// QuickBooks sync: customers and estimates.

import "server-only";
import { database, forOrg } from "@repo/database";
import { saveRecords } from "@repo/ingest/save";
import { credentials } from "../config";
import {
  customerRecords,
  ESTIMATE_YEARS,
  estimateRecords,
  type QbCustomer,
  type QbEnvironment,
  type QbEstimate,
  type QbTerm,
  queryAll,
} from "../quickbooks";
import {
  accessToken,
  type ConnectionRow,
  DAY_MS,
  type SyncResult,
} from "./connection";

/** Customers and estimates from QuickBooks, through the shop data import. */
export const syncQuickBooks = async (
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
