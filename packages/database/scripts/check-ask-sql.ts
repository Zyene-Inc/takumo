// Is this database ready for Ask Takumo's SQL tool? Runs the same security
// check the app runs before every query (reader-check.ts), as the reader
// login, without a shop: it reads only the catalog and the fingerprints, no
// shop's data, and prints only problem names. Exit code 0: ready.
//
//   ASK_DATABASE_URL=<the reader's connection string> pnpm --filter @repo/database check:ask-sql
//
// Use it on staging and production after `pnpm migrate:deploy`, before setting
// ASK_SQL_ENABLED=true (docs/DEPLOY.md, step 1.3).
import pg from "pg";
import { SECURITY_PROBLEMS_SQL } from "../reader-check";

const check = async (client: pg.Client) => {
  const [{ role }] = (
    await client.query<{ role: string }>("select current_user as role")
  ).rows;
  if (role !== "takumo_reader") {
    console.error(
      `Connected as ${role}, not takumo_reader: use the reader's login.`
    );
    return 2;
  }
  await client.query("select set_config('search_path', 'pg_catalog', true)");
  const problems = (
    await client.query<{ problem: string }>(SECURITY_PROBLEMS_SQL)
  ).rows.map((r) => r.problem);
  if (problems.length === 0) {
    console.log("Ask Takumo SQL: database checks passed.");
    return 0;
  }
  console.log("Ask Takumo SQL must stay off. Problems:");
  for (const problem of problems) {
    console.log(`  - ${problem}`);
  }
  return 1;
};

const main = async () => {
  const url = process.env.ASK_DATABASE_URL;
  if (!url) {
    console.error(
      "Set ASK_DATABASE_URL to the takumo_reader connection string."
    );
    return 2;
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin read only");
    return await check(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      `Couldn't run the check: ${(error as Error)?.name ?? "error"}.`
    );
    process.exitCode = 2;
  }
);
