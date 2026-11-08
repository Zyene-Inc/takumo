import { createHmac, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "../generated/client";

vi.mock("server-only", () => ({}));

// Ask Takumo's SQL reaches the database only as a parameter of
// ask_private.run (migration 20261113110000_ask_sql_wrapper), so another
// shop's session of the same takumo_reader login never sees it: not in
// pg_stat_activity, not through query_to_xml, not in pg_stat_statements. And
// the app runs nothing unless the database is set up exactly as reviewed
// (reader-check.ts). Needs TEST_DATABASE_URL (the migrations' role: a
// superuser locally, a non-superuser owner in CI's Supabase-like run) and
// TEST_ASK_DATABASE_URL (takumo_reader).
const ADMIN = process.env.TEST_DATABASE_URL;
const READER = process.env.TEST_ASK_DATABASE_URL;
process.env.ASK_DATABASE_URL = READER;
process.env.SKIP_ENV_VALIDATION = "true";
process.env.ASK_SQL_ENABLED = "true";

const { askQuery, ASK_SQL_OFF, QueryError } = await import("../reader");

// pg_stat_statements can be tested here only if the server preloads it and
// this role may install it (CI's Postgres service doesn't preload it; a
// non-superuser can't install it, as on Supabase): tried in a transaction
// that's rolled back, so nothing is left installed. Elsewhere: staging.
const statementsTestable = async () => {
  if (!ADMIN) {
    return false;
  }
  const client = new pg.Client({ connectionString: ADMIN });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("create extension if not exists pg_stat_statements");
    await client.query("select 1 from pg_stat_statements limit 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
};
const STATEMENTS = await statementsTestable();

const MARK = "SHOPA-SECRET-48213";
const RUN_SQL = "select r from ask_private.run($1, $2) as r";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!(ADMIN && READER))("Ask Takumo's SQL wrapper", () => {
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: ADMIN ?? "" }),
  });
  const shopA = `org_wrap_a_${randomUUID().slice(0, 8)}`;
  const shopB = `org_wrap_b_${randomUUID().slice(0, 8)}`;
  // Session A asks; session B (another shop, same login) watches.
  let a: pg.Client;
  let b: pg.Client;
  let secret = "";
  /** Whether this database shows a reader session's query text at all. */
  let tracked = false;

  const sign = (org: string) =>
    createHmac("sha256", secret).update(org).digest("hex");

  const signedAs = async (client: pg.Client, org: string) => {
    await client.query(
      "select set_config('takumo.org_id', $1, true), set_config('takumo.org_sig', $2, true)",
      [org, sign(org)]
    );
  };

  /** One read-only, signed transaction on a client. */
  const inShop = async <T>(
    client: pg.Client,
    org: string,
    work: () => Promise<T>
  ) => {
    await client.query("begin read only");
    try {
      await signedAs(client, org);
      return await work();
    } finally {
      await client.query("rollback");
    }
  };

  /** Run the wrapper directly (the database's own guarantee, no app checks). */
  const wrapped = (client: pg.Client, statement: string, limit = 10) =>
    client.query<{ r: Record<string, unknown> }>(RUN_SQL, [statement, limit]);

  /** Everything session B can find out about other sessions' SQL, now. */
  const look = () =>
    inShop(b, shopB, async () => {
      const texts: string[] = [];
      const plain = await b.query<{ query: string }>(
        "select query from pg_stat_activity where pid <> pg_backend_pid() and usename = 'takumo_reader'"
      );
      texts.push(...plain.rows.map((r) => r.query));
      const xml = await b.query<{ x: string }>(
        "select query_to_xml('select query from pg_stat_activity where pid <> pg_backend_pid()', true, false, '')::text as x"
      );
      texts.push(xml.rows[0]?.x ?? "");
      const nested = await wrapped(
        b,
        "select query_to_xml('select query from pg_stat_activity', true, false, '')::text as x"
      );
      texts.push(String(nested.rows[0]?.r.x ?? ""));
      return texts;
    });

  /** What B saw while `work` ran in another session. */
  const watch = async (work: () => Promise<unknown>) => {
    const seen: string[] = [];
    let done = false;
    const running = work().finally(() => {
      done = true;
    });
    while (!done) {
      seen.push(...(await look()));
      await sleep(30);
    }
    await running;
    return seen.join("\n");
  };

  /** askQuery's refusal (its problems), or null if it ran. */
  const refusal = (sql = "select name from customers") =>
    askQuery(admin, shopA, sql).then(
      () => null,
      (e: unknown) => e as InstanceType<typeof QueryError>
    );

  const tryAdmin = (sql: string) =>
    admin.$executeRawUnsafe(sql).then(
      () => true,
      () => false
    );

  beforeAll(async () => {
    // The reader's sessions must publish their query text here, as on
    // Supabase (where the hotfix can't turn track_activities off).
    await tryAdmin("alter role takumo_reader reset track_activities");
    a = new pg.Client({ connectionString: READER });
    b = new pg.Client({ connectionString: READER });
    await a.connect();
    await b.connect();
    tracked =
      (await b.query<{ track_activities: string }>("show track_activities"))
        .rows[0].track_activities === "on";
    [{ value: secret }] = await admin.$queryRawUnsafe<{ value: string }[]>(
      "select value from ask_private.secret"
    );
    for (const [org, name] of [
      [shopA, MARK],
      [shopB, "SHOPB-CUSTOMER"],
    ]) {
      await admin.org.create({ data: { id: org, name: org } });
      await admin.customer.create({ data: { orgId: org, name } });
    }
  });

  afterAll(async () => {
    await admin.org.deleteMany({ where: { id: { in: [shopA, shopB] } } });
    // As the first hotfix migration left it, where the role may set it.
    await tryAdmin("alter role takumo_reader set track_activities = off");
    await a.end();
    await b.end();
    await admin.$disconnect();
  });

  test("the wrapper runs with the reader's rights only, a fixed search path, and only the reader may call it", async () => {
    const [run] = await admin.$queryRawUnsafe<
      { definer: boolean; config: string[]; grantees: string[] }[]
    >(
      `select p.prosecdef as definer, p.proconfig as config,
              array(select coalesce(r.rolname::text, 'PUBLIC') from aclexplode(p.proacl) x
                    left join pg_roles r on r.oid = x.grantee
                    where x.grantee <> p.proowner order by 1) as grantees
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ask_private' and p.proname = 'run'`
    );
    expect(run).toEqual({
      definer: false,
      config: ["search_path=pg_catalog, ask, pg_temp"],
      grantees: ["takumo_reader"],
    });
  });

  test("the wrapper refuses: a writable transaction, no signed shop, a bad row limit, anything but one SELECT", async () => {
    const code = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return "ran";
      } catch (error) {
        return (error as { code?: string }).code ?? "error";
      }
    };
    await a.query("begin read write");
    try {
      await signedAs(a, shopA);
      expect(await code(() => wrapped(a, "select 1 as x"))).toBe("25006");
    } finally {
      await a.query("rollback");
    }
    await a.query("begin read only");
    try {
      expect(await code(() => wrapped(a, "select 1 as x"))).toBe("42501");
    } finally {
      await a.query("rollback");
    }
    for (const [statement, limit] of [
      ["select 1 as x", 0],
      ["select 1 as x", 5000],
      ["select 1; select 2", 10],
      ["delete from ask.customers", 10],
      ["select 1) as answer; select (1", 10],
      ["select value from ask_private.secret", 10],
      ['select name from public."Customer"', 10],
    ] as [string, number][]) {
      expect({
        statement,
        result: await inShop(a, shopA, () =>
          code(() => wrapped(a, statement, limit))
        ),
      }).not.toEqual({ statement, result: "ran" });
    }
    // A trailing line comment can't swallow the wrapper's own SQL.
    const rows = await inShop(a, shopA, () =>
      wrapped(a, "select name from customers -- names")
    );
    expect(rows.rows.map((r) => r.r)).toEqual([{ name: MARK }]);
  });

  test("control: without the wrapper, another session reads the query text (so the next tests can fail)", async () => {
    expect(
      tracked,
      "track_activities is off for takumo_reader in this test database; these tests need it on, as on Supabase"
    ).toBe(true);
    const seen = await watch(() =>
      inShop(a, shopA, () =>
        a.query(`select pg_sleep(1), '${MARK}-RAW' as asked`)
      )
    );
    expect(seen).toContain(`${MARK}-RAW`);
  });

  test("through the wrapper: other sessions see only the call, in pg_stat_activity and through query_to_xml", async () => {
    expect(tracked).toBe(true);
    const seen = await watch(() =>
      inShop(a, shopA, () =>
        wrapped(a, `select pg_sleep(1.2), '${MARK}-WRAP' as asked`)
      )
    );
    expect(seen).toContain(RUN_SQL);
    expect(seen).not.toContain(MARK);
  });

  test("through the app: askQuery's SQL never shows up in another session", async () => {
    expect(tracked).toBe(true);
    let result: Awaited<ReturnType<typeof askQuery>> | null = null;
    const seen = await watch(async () => {
      result = await askQuery(
        admin,
        shopA,
        `select count(*) as n, '${MARK}-APP' as asked from generate_series(1, 15000000) as g`
      );
    });
    expect(result).toMatchObject({ rows: [{ n: 15_000_000 }] });
    expect(seen).toContain(RUN_SQL);
    expect(seen).not.toContain(MARK);
  }, 20_000);

  test("nested queries inside the wrapper stay within the reader's rights and the signed shop", async () => {
    const asB = (statement: string) =>
      inShop(b, shopB, async () =>
        JSON.stringify((await wrapped(b, statement)).rows)
      ).catch(
        (error: unknown) => `refused ${(error as { code?: string }).code}`
      );
    const outputs = [
      await asB(
        "select query_to_xml('select * from ask.customers', true, false, '')::text as x"
      ),
      await asB(
        "select table_to_xml('ask.customers', true, false, '')::text as x"
      ),
      await asB(
        "select * from ts_stat('select to_tsvector(name) from ask.customers')"
      ),
    ];
    // Shop B's own rows came back (the queries ran)…
    expect(outputs.join()).toMatch(/shopb/i);
    // …and nothing of shop A's.
    expect(outputs.join()).not.toMatch(/48213|shopa/i);
    expect(
      await asB(
        `select query_to_xml('select name from public."Customer"', true, false, '')::text as x`
      )
    ).toBe("refused 42501");
    expect(
      await asB(
        "select query_to_xml('select value from ask_private.secret', true, false, '')::text as x"
      )
    ).toBe("refused 42501");
  });

  describe("the security check before every query", () => {
    const tampers: [
      name: string,
      tamper: string,
      restore: string,
      problem: RegExp,
    ][] = [
      [
        "a view loses its barrier",
        "alter view ask.customers reset (security_barrier)",
        "alter view ask.customers set (security_barrier = true)",
        /view customers: not a security-barrier view/,
      ],
      [
        "a view's joins lose their shop filter (barrier kept)",
        `create or replace view ask.parts with (security_barrier = true) as
           select p."partNo" as part_no, p.rev, p.description, c.name as customer, m.name as material
           from "Part" p
           left join "Customer" c on c.id = p."customerId"
           left join "Material" m on m.id = p."materialId"
           where p."orgId" = (select ask_private.org_id())`,
        "RESTORE_PARTS",
        /view parts: not the trusted definition/,
      ],
      [
        "a table appears in schema ask",
        "create table ask.extra (x int)",
        "drop table ask.extra",
        /view extra: not a security-barrier view/,
      ],
      [
        "the wrapper becomes SECURITY DEFINER",
        "alter function ask_private.run(text, integer) security definer",
        "alter function ask_private.run(text, integer) security invoker",
        /function run: SECURITY DEFINER/,
      ],
      [
        "another function the reader can run",
        "create function ask_private.extra() returns int language sql as 'select 1'",
        "drop function ask_private.extra()",
        /function extra: runnable by the reader but not trusted/,
      ],
      [
        "the reader can read a base table",
        'grant select on "Customer" to takumo_reader',
        'revoke select on "Customer" from takumo_reader',
        /reader: can read public\.Customer/,
      ],
      [
        "the hotfix marker is missing",
        "delete from ask_private.trusted where kind = 'marker'",
        "select ask_private.record_trusted()",
        /marker: hotfix migrations not applied/,
      ],
    ];

    test("as set up by the migrations: no problems, queries run", async () => {
      expect(await refusal()).toBeNull();
    });

    test.each(
      tampers
    )("%s: off, with the reason logged", async (_name, tamper, restore, problem) => {
      const [{ parts }] = await admin.$queryRawUnsafe<{ parts: string }[]>(
        "select pg_get_viewdef('ask.parts'::regclass) as parts"
      );
      await admin.$executeRawUnsafe(tamper);
      try {
        const refused = await refusal();
        expect(refused?.message).toBe(ASK_SQL_OFF);
        expect(refused?.problems?.join("\n")).toMatch(problem);
      } finally {
        await admin.$executeRawUnsafe(
          restore === "RESTORE_PARTS"
            ? `create or replace view ask.parts with (security_barrier = true) as ${parts}`
            : restore
        );
      }
      expect(await refusal()).toBeNull();
    });

    test("record_trusted() refuses to trust a view that isn't a barrier filtered by the signed shop", async () => {
      await admin.$executeRawUnsafe(
        "alter view ask.calendar reset (security_barrier)"
      );
      try {
        await expect(
          admin.$executeRawUnsafe("select ask_private.record_trusted()")
        ).rejects.toThrow(/security barriers filtered by ask_private\.org_id/);
      } finally {
        await admin.$executeRawUnsafe(
          "alter view ask.calendar set (security_barrier = true)"
        );
      }
      expect(await refusal()).toBeNull();
    });
  });

  // pg_stat_statements needs shared_preload_libraries, which CI's Postgres
  // service doesn't load: there this is skipped, and it must be checked on
  // staging (docs/DEPLOY.md, step 1.3). Runs last: while the extension is in
  // public, the reader could read it and the security check turns queries off.
  test.runIf(STATEMENTS)(
    "pg_stat_statements never holds the agent's SQL (needs staging verification where not preloaded)",
    async () => {
      await admin.$executeRawUnsafe(
        "create extension if not exists pg_stat_statements"
      );
      try {
        await inShop(a, shopA, () =>
          wrapped(
            a,
            `select '${MARK}-STATEMENTS' as asked, count(*) from ask.customers`
          )
        );
        const [{ texts }] = await admin.$queryRawUnsafe<{ texts: string }[]>(
          "select coalesce(string_agg(query, E'\\n'), '') as texts from pg_stat_statements where userid = 'takumo_reader'::regrole"
        );
        expect(texts).toContain("ask_private.run");
        expect(texts).not.toContain(MARK);
      } finally {
        await tryAdmin("drop extension pg_stat_statements");
      }
    }
  );
});
