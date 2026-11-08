import { FIELDS, FUNCTIONS, NODES, TYPES } from "./sql-allow-list";
import { QueryError } from "./sql-guard";

// Ask Takumo's SQL, checked against an allowlist on Postgres's own parse tree
// (libpg-query: the real parser, compiled to WebAssembly, so it reads the
// query exactly as the database will: U&"…" names, comments, dollar quotes).
// Only one SELECT over the ask views, with plain functions, casts and node
// types, gets through. That keeps out what the database would allow the
// reader but the agent never needs: system catalogs (pg_stat_activity,
// pg_class), functions that run a query of their own (query_to_xml,
// table_to_xml, ts_stat), settings (current_setting), regclass-style casts
// and anything that isn't a read. The database (barrier views, reader grants,
// read-only transaction) stays the real boundary; this narrows what reaches it.

/** The views the agent may read (migration 20261031120000_ask_takumo). */
export const ASK_VIEWS = new Set([
  "work_centers",
  "customers",
  "materials",
  "parts",
  "routings",
  "orders",
  "quotes",
  "jobs",
  "calendar",
  "facts",
]);

const MAX_SQL_CHARS = 10_000;

type Json = unknown;
type NodeFields = Record<string, Json>;

const names = (list: Json): string[] =>
  Array.isArray(list)
    ? list.map(
        (item) => (item as { String?: { sval?: string } }).String?.sval ?? ""
      )
    : [];

/** A name that is unqualified or in pg_catalog, or null. */
const builtIn = (list: Json) => {
  const parts = names(list);
  if (parts.length === 1) {
    return parts[0];
  }
  if (parts.length === 2 && parts[0] === "pg_catalog") {
    return parts[1];
  }
  return null;
};

const refuse = (message: string): never => {
  throw new QueryError(message);
};

const CTE_NAME = /^[a-z_][a-z0-9_]*$/;

const checkRelation = (fields: NodeFields, ctes: Set<string>) => {
  const relname = String(fields.relname ?? "");
  const schema = fields.schemaname;
  if (fields.catalogname !== undefined) {
    refuse(`"${relname}" can't be read: only the views listed can be queried.`);
  }
  if (schema === "ask" && ASK_VIEWS.has(relname)) {
    return;
  }
  if (schema === undefined && ASK_VIEWS.has(relname)) {
    return;
  }
  // A WITH name: unqualified, never one that could be a system catalog.
  if (schema === undefined && ctes.has(relname)) {
    return;
  }
  refuse(
    `"${schema ? `${String(schema)}.` : ""}${relname}" can't be read: only the views listed can be queried.`
  );
};

const checkType = (fields: NodeFields) => {
  const name = builtIn(fields.names);
  if (!(name && TYPES.has(name))) {
    refuse(
      `Casting to ${names(fields.names).join(".")} isn't allowed in data queries.`
    );
  }
};

const checkNode = (type: string, fields: NodeFields, ctes: Set<string>) => {
  if (!NODES.has(type)) {
    refuse(
      `This kind of SQL (${type}) isn't allowed: send one plain SELECT over the views listed.`
    );
  }
  if (type === "RangeVar") {
    checkRelation(fields, ctes);
  } else if (type === "FuncCall") {
    const name = builtIn(fields.funcname);
    if (!(name && FUNCTIONS.has(name))) {
      refuse(
        `The function ${names(fields.funcname).join(".")}() isn't allowed in data queries.`
      );
    }
  } else if (type === "TypeName") {
    checkType(fields);
  } else if (
    // Operators: only built-in ones (no OPERATOR(schema.op)).
    type === "A_Expr" &&
    fields.name !== undefined &&
    !builtIn(fields.name)
  ) {
    refuse("Only built-in operators are allowed in data queries.");
  }
};

type Visit = (type: string, fields: NodeFields) => void;

const NODE_TYPE = /^[A-Z]/;

/**
 * Every node in a parse tree, depth first: node types are capitalised keys,
 * fields lower-case ones. A field must be in FIELDS; a typeName field (a
 * cast's type, inline) is checked as a type wherever it appears.
 */
const walk = (value: Json, visit: Visit) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, inner] of Object.entries(value as NodeFields)) {
    if (NODE_TYPE.test(key)) {
      visit(key, (inner ?? {}) as NodeFields);
    } else if (!FIELDS.has(key)) {
      refuse(
        `This kind of SQL (${key}) isn't allowed: send one plain SELECT over the views listed.`
      );
    } else if (key === "typeName") {
      checkType((inner ?? {}) as NodeFields);
    }
    walk(inner, visit);
  }
};

interface ParseResult {
  stmts?: { stmt?: Json; stmt_len?: number; stmt_location?: number }[];
}

const parseSql = async (sql: string): Promise<ParseResult> => {
  let parse: (sql: string) => Promise<unknown>;
  try {
    ({ parse } = await import("libpg-query"));
  } catch {
    // Without the parser nothing can be checked: refuse.
    throw new QueryError("Data queries aren't available right now.", {
      stage: "off",
    });
  }
  try {
    return (await parse(sql)) as ParseResult;
  } catch (error) {
    const at = (error as { sqlDetails?: { cursorPosition?: number } })
      ?.sqlDetails?.cursorPosition;
    throw new QueryError(
      `The SQL has a syntax error${typeof at === "number" ? ` near character ${at + 1}` : ""}.`
    );
  }
};

/**
 * Check the agent's SQL and return the one statement to run (its text as
 * written, without a trailing semicolon). Throws QueryError with a message
 * about the agent's own SQL; never runs anything.
 */
export const allowSql = async (sql: string): Promise<string> => {
  if (!sql.trim()) {
    refuse("The query is empty.");
  }
  if (sql.length > MAX_SQL_CHARS) {
    refuse(`Keep queries under ${MAX_SQL_CHARS.toLocaleString()} characters.`);
  }
  const { stmts = [] } = await parseSql(sql);
  if (stmts.length !== 1) {
    refuse(
      stmts.length === 0
        ? "The query is empty."
        : "Send one SELECT statement at a time."
    );
  }
  const [{ stmt, stmt_len: length, stmt_location: start = 0 }] = stmts;
  if (!(stmt && typeof stmt === "object" && "SelectStmt" in stmt)) {
    refuse("Only SELECT (or WITH … SELECT) queries are allowed.");
  }
  const ctes = new Set<string>();
  walk(stmt, (type, fields) => {
    if (type === "CommonTableExpr") {
      const name = String(fields.ctename ?? "");
      if (!CTE_NAME.test(name) || name.startsWith("pg_")) {
        refuse(`Use another name for "${name}" in WITH.`);
      }
      ctes.add(name);
    }
  });
  walk(stmt, (type, fields) => checkNode(type, fields, ctes));
  // The statement exactly as written (offsets are in UTF-8 bytes).
  const bytes = Buffer.from(sql, "utf8");
  const text = bytes
    .subarray(start, length ? start + length : bytes.length)
    .toString("utf8")
    .trim();
  return text;
};
