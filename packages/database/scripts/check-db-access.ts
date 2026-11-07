// Read-only check of what the app's database login can do:
//   - whether row-level security applies to it (or it bypasses RLS),
//   - whether it can call the Knowledge Hub's library.* permission functions,
//   - that the Ask Takumo reader and Supabase's API roles can't.
//
// Usage (the URL is taken only from the environment; .env files are NOT read,
// so it never points at a database by accident):
//   DATABASE_URL=postgresql://… pnpm --filter @repo/database check:db-access
//
// Prints the host, role names and yes/no answers, never credentials. Every
// query runs in one READ ONLY transaction that is rolled back.
import pg from "pg";

const TABLES = ["Org", "Source", "DocChunk", "Fact", "Folder", "AccessGrant"];
const OTHER_ROLES = ["takumo_reader", "anon", "authenticated"];

const yesNo = (value: boolean | null | undefined) => {
  if (value === null || value === undefined) {
    return "n/a";
  }
  return value ? "yes" : "no";
};

/**
 * Behaviour, not just settings: with a claim for a shop that can't exist,
 * RLS (if it applies) must hide every row of Org.
 */
const rlsVerdict = async (client: pg.Client) => {
  await client.query("savepoint rls_check");
  try {
    const total = await client.query<{ n: string }>(
      `select count(*) as n from "Org"`
    );
    await client.query(
      `select set_config('request.jwt.claims', '{"org_id":"__no_such_shop__"}', true)`
    );
    const scoped = await client.query<{ n: string }>(
      `select count(*) as n from "Org"`
    );
    const rows = Number(total.rows[0]?.n ?? 0);
    if (rows === 0) {
      return "RLS applies to this login: n/a (Org is empty, so it can't be told)";
    }
    return `RLS applies to this login: ${yesNo(Number(scoped.rows[0]?.n ?? 0) === 0)}`;
  } catch {
    await client.query("rollback to savepoint rls_check");
    return "RLS applies to this login: n/a (this login can't read the Org table at all)";
  }
};

const main = async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL for the database to check.");
    process.exit(2);
  }
  const target = new URL(url);
  console.log(
    `Database: ${target.hostname}:${target.port || 5432}${target.pathname}`
  );

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("begin transaction read only");
    const login = await client.query<{
      bypass: boolean;
      name: string;
      superuser: boolean;
    }>(
      `select current_user as name, r.rolsuper as superuser, r.rolbypassrls as bypass
       from pg_roles r where r.rolname = current_user`
    );
    const me = login.rows[0];
    console.log(`App login role: ${me?.name}`);
    console.log(`  superuser: ${yesNo(me?.superuser)}`);
    console.log(`  BYPASSRLS attribute: ${yesNo(me?.bypass)}`);

    const tables = await client.query<{
      force: boolean;
      name: string;
      owned: boolean;
      rls: boolean;
    }>(
      `select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force,
              pg_get_userbyid(c.relowner) = current_user as owned
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1)
       order by c.relname`,
      [TABLES]
    );
    for (const t of tables.rows) {
      console.log(
        `  ${t.name}: RLS enabled ${yesNo(t.rls)}, forced ${yesNo(t.force)}, owned by this login ${yesNo(t.owned)}`
      );
    }

    console.log(await rlsVerdict(client));

    const library = await client.query<{ fn: boolean; usage: boolean }>(
      `select has_schema_privilege(current_user, 'library', 'USAGE') as usage,
              case when has_schema_privilege(current_user, 'library', 'USAGE')
                then has_function_privilege(current_user,
                  'library.visible_source_ids(text, text, text)', 'EXECUTE')
                else false end as fn`
    );
    console.log(
      `This login can use library.*: ${yesNo(library.rows[0]?.usage && library.rows[0]?.fn)}`
    );
    for (const role of OTHER_ROLES) {
      const other = await client.query<{ usage: boolean | null }>(
        `select case when exists (select 1 from pg_roles where rolname = $1)
                then has_schema_privilege($1, 'library', 'USAGE') end as usage`,
        [role]
      );
      const usage = other.rows[0]?.usage;
      console.log(
        `  ${role} can use library.*: ${usage === null || usage === undefined ? "role not present" : yesNo(usage)}`
      );
    }
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
};

main().catch((error: unknown) => {
  // The message only; connection errors can include the URL.
  console.error(
    `Check failed: ${error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "<url>") : "unknown error"}`
  );
  process.exitCode = 1;
});
