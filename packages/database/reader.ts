import "server-only";

import { createHmac } from "node:crypto";
import pg from "pg";
import type { PrismaClient } from "./generated/client";
import { keys } from "./keys";
import { checkSql, QueryError } from "./sql-guard";

export { QueryError } from "./sql-guard";

/**
 * Read-only SQL for Ask Takumo, run as the takumo_reader login. The reader can
 * only SELECT the views in schema "ask", and each view shows only the shop
 * whose id is signed with the secret in ask_private.secret (see migration
 * 20261031120000_ask_takumo). Rewriting the setting from inside a query
 * returns no rows; everything else is refused by the database itself.
 */

const MAX_ROWS = 200;

type QueryRow = Record<string, string | number | boolean | null | (string | number | null)[]>;

interface QueryResult {
  columns: string[];
  rows: QueryRow[];
  /** More rows matched than MAX_ROWS. */
  truncated: boolean;
}

const toJson = (value: unknown): QueryRow[string] => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    // Dates without a time stay dates.
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => toJson(v) as string | number | null);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
};

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

/** Run one read-only SELECT over the current shop's ask.* views. */
export const askQuery = async (
  admin: PrismaClient,
  orgId: string,
  sql: string
): Promise<QueryResult> => {
  const statement = checkSql(sql);
  const signature = createHmac("sha256", await signingSecret(admin))
    .update(orgId)
    .digest("hex");
  const client = await pool().connect();
  try {
    await client.query("begin read only");
    await client.query(
      "select set_config('takumo.org_id', $1, true), set_config('takumo.org_sig', $2, true)",
      [orgId, signature]
    );
    // The extended protocol runs exactly one statement.
    // (queryMode is in pg ≥ 8.11; @types/pg doesn't list it yet.)
    const query: pg.QueryConfig & { queryMode: "extended" } = {
      queryMode: "extended",
      text: `select * from (${statement}) as answer limit ${MAX_ROWS + 1}`,
    };
    const result = await client.query(query);
    const rows = result.rows.map((row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toJson(v)]))
    );
    return {
      columns: result.fields.map((f) => f.name),
      rows: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
    };
  } catch (error) {
    if (error instanceof QueryError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new QueryError(message);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
};
