import "server-only";

import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";
import type { PrismaClient } from "./generated/client";
import { keys } from "./keys";
import { SECURITY_PROBLEMS_SQL } from "./reader-check";
import { allowSql } from "./sql-allow";
import { checkSql, QueryError } from "./sql-guard";

export { QueryError } from "./sql-guard";

/**
 * Read-only SQL for Ask Takumo, run as the takumo_reader login. The reader can
 * only SELECT the views in schema "ask", and each view shows only the shop
 * whose id is signed with the secret in ask_private.secret (see migration
 * 20261031120000_ask_takumo). Rewriting the setting from inside a query
 * returns no rows; everything else is refused by the database itself.
 *
 * Security hotfix (migrations 20261113100000_ask_view_isolation and
 * 20261113110000_ask_sql_wrapper):
 * - Off unless ASK_SQL_ENABLED is exactly "true" AND the database passes
 *   reader-check.ts at the start of every query (hotfix migrations applied,
 *   views and functions exactly as recorded, reader privileges as expected).
 * - The agent's SQL is checked against an allowlist on Postgres's own parse
 *   tree first (sql-allow.ts): one SELECT over the ask views, plain functions.
 * - It reaches the database only as a bind parameter of ask_private.run, so
 *   other sessions of the reader (other shops) never see its text in
 *   pg_stat_activity.
 * - No database error text is ever passed on (it can quote a row's value):
 *   the caller gets a fixed message by kind of error and a reference that the
 *   server logs with the SQLSTATE.
 */

/** What the agent is told while data queries are off. */
export const ASK_SQL_OFF =
  "Data queries are turned off for now, so counts, totals and lists can't be worked out with SQL.";

const MAX_ROWS = 200;

type QueryRow = Record<
  string,
  string | number | boolean | null | (string | number | null)[]
>;

interface QueryResult {
  columns: string[];
  rows: QueryRow[];
  /** More rows matched than MAX_ROWS. */
  truncated: boolean;
}

// numeric/bigint come back as strings from pg; numbers are what the agent needs.
const NUMERIC_TYPES = [20, 1700]; // int8, numeric
for (const oid of NUMERIC_TYPES) {
  pg.types.setTypeParser(oid, (v) => (v === null ? null : Number(v)));
}
// Plain dates as YYYY-MM-DD, not midnight in the server's zone.
pg.types.setTypeParser(1082, (v) => v);

const globalForReader = global as unknown as {
  askPool?: pg.Pool;
  askSecret?: string;
};

const pool = () => {
  const url = keys().ASK_DATABASE_URL;
  if (!url) {
    throw new QueryError(
      "Data queries aren't set up (ASK_DATABASE_URL is missing). See docs/DEPLOY.md."
    );
  }
  globalForReader.askPool ??= new pg.Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return globalForReader.askPool;
};

const signingSecret = async (admin: PrismaClient) => {
  if (!globalForReader.askSecret) {
    const rows = await admin.$queryRawUnsafe<{ value: string }[]>(
      "select value from ask_private.secret"
    );
    if (!rows[0]) {
      throw new QueryError("Data queries aren't set up (no signing secret).");
    }
    globalForReader.askSecret = rows[0].value;
  }
  return globalForReader.askSecret;
};

const switchedOn = () => keys().ASK_SQL_ENABLED === "true";

/** A short reference to find a failed query in the server's logs. */
const newRef = () => randomBytes(4).toString("hex");

const sqlState = (error: unknown) =>
  typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : undefined;

// Fixed messages by kind of error. No part of the database's own message,
// detail, hint or position is ever passed on: it can quote a row's value, a
// setting or the session's signature, even while the query is only planned.
const FAILURES: [prefix: string, message: string][] = [
  [
    "57014",
    "The query took longer than 5 seconds and was stopped. Narrow it down or aggregate.",
  ],
  [
    "22",
    "A value couldn't be converted or calculated (for example a text column cast to a number or date, or dividing by zero). Avoid casting text columns.",
  ],
];
const GENERIC_FAILURE =
  "The query couldn't be run. Check the view and column names and the functions in the tool description.";

/** The error the caller gets for a database failure (exported for tests). */
export const queryFailure = (error: unknown) => {
  const ref = newRef();
  const state = sqlState(error);
  const known = state
    ? FAILURES.find(([prefix]) => state.startsWith(prefix))?.[1]
    : undefined;
  return new QueryError(`${known ?? GENERIC_FAILURE} (ref ${ref})`, {
    ref,
    sqlState: state,
    stage: "run",
  });
};

/** A value from the json rows as the agent gets it. */
const fromJson = (value: unknown): QueryRow[string] => {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((v) => {
      const item = fromJson(v);
      return Array.isArray(item) || typeof item === "boolean"
        ? JSON.stringify(item)
        : item;
    });
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
};

const RUN_SQL = "select r from ask_private.run($1, $2) as r";

/**
 * Run one read-only SELECT over the current shop's ask.* views. Throws
 * QueryError (with ASK_SQL_OFF while switched off or not verified); its
 * message is safe to show the agent and the person asking.
 */
export const askQuery = async (
  admin: PrismaClient,
  orgId: string,
  sql: string
): Promise<QueryResult> => {
  if (!switchedOn()) {
    throw new QueryError(ASK_SQL_OFF, { stage: "off" });
  }
  // Friendly first messages, then the parse-tree allowlist decides.
  checkSql(sql);
  const statement = await allowSql(sql);
  const signature = createHmac("sha256", await signingSecret(admin))
    .update(orgId)
    .digest("hex");
  const client = await pool().connect();
  try {
    await client.query("begin read only");
    await client.query("select set_config('search_path', 'pg_catalog', true)");
    const problems = (
      await client.query<{ problem: string }>(SECURITY_PROBLEMS_SQL)
    ).rows.map((r) => r.problem);
    if (problems.length > 0) {
      throw new QueryError(ASK_SQL_OFF, { stage: "off", problems });
    }
    await client.query(
      "select set_config('takumo.org_id', $1, true), set_config('takumo.org_sig', $2, true)",
      [orgId, signature]
    );
    // The statement is a parameter: pg_stat_activity shows only RUN_SQL.
    const result = await client
      .query<{ r: Record<string, unknown> }>(RUN_SQL, [statement, MAX_ROWS + 1])
      .catch((error: unknown) => {
        throw queryFailure(error);
      });
    const rows = result.rows.map(({ r }) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fromJson(v)]))
    );
    return {
      // Column names come with the rows (none when nothing matched).
      columns: rows[0] ? Object.keys(rows[0]) : [],
      rows: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
    };
  } catch (error) {
    if (error instanceof QueryError) {
      throw error;
    }
    // Connecting or checking failed: no driver text either.
    throw queryFailure(error);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
};
