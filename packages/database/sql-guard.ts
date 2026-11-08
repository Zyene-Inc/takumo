// A fast, friendly check of the agent's SQL before it reaches the database.
// The takumo_reader role's permissions are the real guarantee (see reader.ts);
// this only turns obvious mistakes into clear messages. Pure, so tested.

export interface QueryErrorDetails {
  /** Reference shown with the message, to find the failure in the logs. */
  ref?: string;
  /** Postgres SQLSTATE, for the logs; never the database's own message. */
  sqlState?: string;
  /** Where it failed: "check" (here), "off", "plan" or "run" (reader.ts). */
  stage?: "check" | "off" | "plan" | "run";
}

/** A query that didn't run; its message is safe to show the agent. */
export class QueryError extends Error {
  readonly ref?: string;
  readonly sqlState?: string;
  readonly stage: NonNullable<QueryErrorDetails["stage"]>;

  constructor(message: string, details: QueryErrorDetails = {}) {
    super(message);
    this.name = "QueryError";
    this.ref = details.ref;
    this.sqlState = details.sqlState;
    this.stage = details.stage ?? "check";
  }
}

const FORBIDDEN =
  /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|prepare|listen|notify|lock|vacuum|analyze|cluster|reindex|refresh|comment|security|set_config|pg_sleep|dblink|lo_\w+|pg_read\w*|pg_ls\w*|pg_stat\w*)\b/i;
// U&"..." names and U&'...' strings spell words the checks above can't see.
const UNICODE_ESCAPE = /\bu&/i;
const LEADING = /^\s*(with|select)\b/i;
const LINE_COMMENT = /--[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const STRINGS = /'(?:[^']|'')*'/g;
const TRAILING_SEMICOLON = /;\s*$/;

/**
 * A friendly first check so the agent gets a clear message. The database
 * permissions are the real guarantee; this just fails fast.
 */
export const checkSql = (sql: string): string => {
  const cleaned = sql
    .replace(BLOCK_COMMENT, " ")
    .replace(LINE_COMMENT, " ")
    .trim();
  const statement = cleaned.replace(TRAILING_SEMICOLON, "");
  if (!statement) {
    throw new QueryError("The query is empty.");
  }
  // Keywords inside string literals ('delete me') are fine.
  const code = statement.replace(STRINGS, "''");
  if (code.includes(";")) {
    throw new QueryError("Send one SELECT statement at a time.");
  }
  if (!LEADING.test(code)) {
    throw new QueryError("Only SELECT (or WITH … SELECT) queries are allowed.");
  }
  if (UNICODE_ESCAPE.test(code)) {
    throw new QueryError("Unicode escapes (U&) aren't allowed in queries.");
  }
  const bad = code.match(FORBIDDEN);
  if (bad) {
    throw new QueryError(`"${bad[0]}" isn't allowed: queries are read-only.`);
  }
  return statement;
};
