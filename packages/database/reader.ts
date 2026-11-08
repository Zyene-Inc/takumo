import "server-only";

import { createHmac, randomBytes } from "node:crypto";
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
 *
 * Security hotfix (migration 20261113100000_ask_view_isolation):
 * - Off unless ASK_SQL_ENABLED is "true" AND every relation in schema "ask"
 *   is a security-barrier view (checked on every query, in the database the
 *   reader uses). Before the views were barriers, a condition in the query
 *   could run on other shops' rows and quote them in its error.
 * - Errors raised while rows are read can quote a row's value, so they are
 *   never passed on: the caller gets a plain message and a reference. Errors
 *   from planning the query (before any row is read: unknown column, syntax)
 *   are passed on so the agent can fix its SQL.
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

// Relations in schema "ask" that aren't security-barrier views.
const UNSAFE_VIEWS_SQL = `
  select count(*)::int as unsafe
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'ask'
    and not (c.relkind = 'v' and coalesce((
      select bool_or(o.option_name = 'security_barrier' and o.option_value in ('true', 'on', '1'))
      from pg_options_to_table(c.reloptions) o), false))`;

const switchedOn = () => keys().ASK_SQL_ENABLED === "true";

/** A short reference to find a failed query in the server's logs. */
const newRef = () => randomBytes(4).toString("hex");

const sqlState = (error: unknown) =>
  typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : undefined;

// Planning reads no rows, so its errors (class 42: syntax, unknown column or
// view, wrong types, no permission; class 0A: not supported) only describe
// the query and the schema. Anything else is answered in general terms.
const PLAN_MESSAGE_CLASSES = ["42", "0A"];

const planError = (error: unknown) => {
  const ref = newRef();
  const state = sqlState(error);
  const message =
    state &&
    PLAN_MESSAGE_CLASSES.includes(state.slice(0, 2)) &&
    error instanceof Error
      ? error.message.split("\n")[0].slice(0, 300)
      : "The query couldn't be planned.";
  return new QueryError(`${message} (ref ${ref})`, {
    ref,
    sqlState: state,
    stage: "plan",
  });
};

// While rows are read, an error can quote a value from one (a failed cast,
// a regclass lookup): only its kind is passed on.
const RUN_MESSAGES: [prefix: string, message: string][] = [
  [
    "57014",
    "The query took longer than 5 seconds and was stopped. Narrow it down or aggregate.",
  ],
  [
    "22",
    "A value in the data couldn't be converted or calculated (a text column cast to a number or date, or dividing by zero). Avoid casting text columns.",
  ],
  ["21000", "A subquery used as a value returned more than one row."],
  ["53", "The query needed too much memory. Narrow it down or aggregate."],
  ["54", "The query is too complex. Simplify it."],
];

const runError = (error: unknown) => {
  const ref = newRef();
  const state = sqlState(error);
  const known = state
    ? RUN_MESSAGES.find(([prefix]) => state.startsWith(prefix))?.[1]
    : undefined;
  return new QueryError(
    `${known ?? "The query failed while reading the data."} (ref ${ref})`,
    { ref, sqlState: state, stage: "run" }
  );
};

/**
 * Run one read-only SELECT over the current shop's ask.* views. Throws
 * QueryError (with ASK_SQL_OFF while switched off); its message is safe to
 * show the agent and the person asking.
 */
export const askQuery = async (
  admin: PrismaClient,
  orgId: string,
  sql: string
): Promise<QueryResult> => {
  if (!switchedOn()) {
    throw new QueryError(ASK_SQL_OFF, { stage: "off" });
  }
  const statement = checkSql(sql);
  const signature = createHmac("sha256", await signingSecret(admin))
    .update(orgId)
    .digest("hex");
  const client = await pool().connect();
  try {
    await client.query("begin read only");
    const [{ unsafe }] = (
      await client.query<{ unsafe: number }>(UNSAFE_VIEWS_SQL)
    ).rows;
    if (unsafe > 0) {
      throw new QueryError(ASK_SQL_OFF, { stage: "off" });
    }
    await client.query(
      "select set_config('takumo.org_id', $1, true), set_config('takumo.org_sig', $2, true)",
      [orgId, signature]
    );
    const text = `select * from (${statement}) as answer limit ${MAX_ROWS + 1}`;
    // The extended protocol runs exactly one statement.
    // (queryMode is in pg ≥ 8.11; @types/pg doesn't list it yet.)
    const plan: pg.QueryConfig & { queryMode: "extended" } = {
      queryMode: "extended",
      text: `explain ${text}`,
    };
    await client.query(plan).catch((error: unknown) => {
      throw planError(error);
    });
    const query: pg.QueryConfig & { queryMode: "extended" } = {
      queryMode: "extended",
      text,
    };
    const result = await client.query(query).catch((error: unknown) => {
      throw runError(error);
    });
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
    // Connecting or setting up failed: nothing from the query, but no
    // driver text either.
    throw runError(error);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
};
