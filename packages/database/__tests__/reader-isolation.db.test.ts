import { createHmac, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "../generated/client";

vi.mock("server-only", () => ({}));

// Ask Takumo's SQL can't reach another shop's rows, even through an error
// message (hotfix migration 20261113100000_ask_view_isolation). Shop B's
// values all carry a marker; shop A's queries must never show it: not in
// rows, not in errors, not in another session's query text. Needs
// TEST_DATABASE_URL (an admin login) and TEST_ASK_DATABASE_URL (takumo_reader).
const ADMIN = process.env.TEST_DATABASE_URL;
const READER = process.env.TEST_ASK_DATABASE_URL;
process.env.ASK_DATABASE_URL = READER;
process.env.SKIP_ENV_VALIDATION = "true";

const { askQuery, QueryError, ASK_SQL_OFF } = await import("../reader");

const MARK = "58213";
const B = (what: string) => `ORGB-LEAK-${what}-${MARK}`;
const leaks = (text: string) => text.includes(MARK);

describe.skipIf(!(ADMIN && READER))("Ask Takumo: no other shop's data", () => {
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: ADMIN ?? "" }),
  });
  const reader = new pg.Client({ connectionString: READER });
  const other = new pg.Client({ connectionString: READER });
  const shopA = `org_iso_a_${randomUUID().slice(0, 8)}`;
  const shopB = `org_iso_b_${randomUUID().slice(0, 8)}`;
  // Shop C's rows point at shop B's (see beforeAll); A and B are clean.
  const shopC = `org_iso_c_${randomUUID().slice(0, 8)}`;
  let secret = "";
  /** Every text column of every ask view, as [view, column]. */
  let columns: [string, string][] = [];

  const sign = (org: string) =>
    createHmac("sha256", secret).update(org).digest("hex");

  /**
   * Raw reader access as a shop, skipping the app's checks: what the
   * database itself allows. `hash` forces hash joins, which scan every
   * joined table in full: the plan an attacker would hope for.
   */
  const as = async (org: string, sql: string, hash = false) => {
    await reader.query("begin read only");
    try {
      await reader.query(
        "select set_config('takumo.org_id', $1, true), set_config('takumo.org_sig', $2, true)",
        [org, sign(org)]
      );
      if (hash) {
        await reader.query(
          "set local enable_nestloop = off; set local enable_mergejoin = off"
        );
      }
      return (await reader.query(sql)).rows;
    } finally {
      await reader.query("rollback");
    }
  };

  const errorOf = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  beforeAll(async () => {
    await reader.connect();
    await other.connect();
    [{ value: secret }] = await admin.$queryRawUnsafe<{ value: string }[]>(
      "select value from ask_private.secret"
    );
    const made: Record<string, Record<string, string>> = {};
    for (const [org, name] of [
      [shopA, (what: string) => `A-${what}`],
      [shopB, B],
    ] as const) {
      await admin.org.create({ data: { id: org, name: org } });
      const customer = await admin.customer.create({
        data: { orgId: org, name: name("CUSTOMER") },
      });
      const material = await admin.material.create({
        data: { orgId: org, name: name("MATERIAL"), spec: name("SPEC") },
      });
      const machine = await admin.workCenter.create({
        data: { orgId: org, name: name("MACHINE"), type: name("TYPE") },
      });
      const part = await admin.part.create({
        data: {
          orgId: org,
          partNo: name("PART"),
          description: name("DESCRIPTION"),
          customerId: customer.id,
          materialId: material.id,
        },
      });
      await admin.routing.create({
        data: {
          orgId: org,
          partId: part.id,
          seq: 10,
          workCenterId: machine.id,
          altWorkCenterIds: [machine.id],
          setupMin: 30,
          runMinPerUnit: 2,
        },
      });
      const order = await admin.order.create({
        data: {
          orgId: org,
          orderNo: name("ORDER"),
          partId: part.id,
          customerId: customer.id,
          qty: 5,
          dueDate: new Date("2026-12-01"),
        },
      });
      await admin.quote.create({
        data: {
          orgId: org,
          quoteNo: name("QUOTE"),
          partId: part.id,
          customerId: customer.id,
          qty: 5,
        },
      });
      await admin.job.create({
        data: {
          orgId: org,
          orderId: order.id,
          routingSeq: 10,
          workCenterId: machine.id,
        },
      });
      await admin.calendarDay.create({
        data: {
          orgId: org,
          workCenterId: machine.id,
          date: new Date("2026-12-02"),
          availableHours: 4,
          reason: name("REASON"),
        },
      });
      await admin.fact.create({
        data: {
          orgId: org,
          number: 1,
          subjectType: "part",
          subjectId: part.id,
          subjectLabel: name("SUBJECT"),
          attribute: "note",
          value: name("FACT"),
          evidence: name("EVIDENCE"),
        },
      });
      made[org] = {
        customer: customer.id,
        material: material.id,
        machine: machine.id,
        part: part.id,
        order: order.id,
      };
    }
    // Shop C rows that point at shop B's (nothing in the schema forbids it:
    // an import or sync bug could make one). The views must not follow them.
    await admin.org.create({ data: { id: shopC, name: shopC } });
    const b = made[shopB];
    const cMachine = await admin.workCenter.create({
      data: { orgId: shopC, name: "C-MACHINE" },
    });
    const cross = await admin.part.create({
      data: {
        orgId: shopC,
        partNo: "C-CROSS",
        customerId: b.customer,
        materialId: b.material,
      },
    });
    await admin.routing.create({
      data: {
        orgId: shopC,
        partId: b.part,
        seq: 20,
        workCenterId: b.machine,
        altWorkCenterIds: [b.machine],
        setupMin: 1,
        runMinPerUnit: 1,
      },
    });
    await admin.routing.create({
      data: {
        orgId: shopC,
        partId: cross.id,
        seq: 30,
        workCenterId: cMachine.id,
        altWorkCenterIds: [b.machine],
        setupMin: 1,
        runMinPerUnit: 1,
      },
    });
    const crossOrder = await admin.order.create({
      data: {
        orgId: shopC,
        orderNo: "C-CROSS-ORDER",
        partId: b.part,
        customerId: b.customer,
        qty: 1,
        dueDate: new Date("2026-12-01"),
      },
    });
    await admin.quote.create({
      data: {
        orgId: shopC,
        quoteNo: "C-CROSS-QUOTE",
        partId: b.part,
        customerId: b.customer,
        qty: 1,
      },
    });
    await admin.job.create({
      data: {
        orgId: shopC,
        orderId: b.order,
        routingSeq: 20,
        workCenterId: b.machine,
      },
    });
    await admin.job.create({
      data: {
        orgId: shopC,
        orderId: crossOrder.id,
        routingSeq: 10,
        workCenterId: b.machine,
      },
    });
    await admin.calendarDay.create({
      data: {
        orgId: shopC,
        workCenterId: b.machine,
        date: new Date("2026-12-03"),
        availableHours: 1,
      },
    });
    columns = (
      await admin.$queryRawUnsafe<{ view: string; column: string }[]>(
        `select table_name as view, column_name as column
         from information_schema.columns
         where table_schema = 'ask' and data_type in ('text', 'character varying')
         order by 1, 2`
      )
    ).map((c) => [c.view, c.column]);
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe(
      `delete from "Job" where "orgId" in ($1, $2, $3)`,
      shopA,
      shopB,
      shopC
    );
    for (const table of ["Order", "Quote", "Routing", "CalendarDay"]) {
      await admin.$executeRawUnsafe(
        `delete from "${table}" where "orgId" in ($1, $2, $3)`,
        shopA,
        shopB,
        shopC
      );
    }
    await admin.org.deleteMany({
      where: { id: { in: [shopA, shopB, shopC] } },
    });
    await admin.$disconnect();
    await reader.end();
    await other.end();
  });

  test("every relation the reader can see is a security-barrier view", async () => {
    const relations = await admin.$queryRawUnsafe<
      { name: string; kind: string; barrier: boolean }[]
    >(
      `select c.relname as name, c.relkind::text as kind,
              coalesce((select bool_or(o.option_name = 'security_barrier' and o.option_value in ('true', 'on', '1'))
                        from pg_options_to_table(c.reloptions) o), false) as barrier
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'ask'`
    );
    expect(relations.length).toBeGreaterThanOrEqual(10);
    expect(relations.filter((r) => !(r.kind === "v" && r.barrier))).toEqual([]);
  });

  test("the reader may only read the ask views", async () => {
    const grants = await admin.$queryRawUnsafe<
      { schema: string; privilege: string }[]
    >(
      `select distinct table_schema as schema, privilege_type as privilege
       from information_schema.role_table_grants where grantee = 'takumo_reader'`
    );
    expect(grants).toEqual([{ schema: "ask", privilege: "SELECT" }]);
    const [can] = await admin.$queryRawUnsafe<
      { create_public: boolean; secret: boolean }[]
    >(
      `select has_schema_privilege('takumo_reader', 'public', 'CREATE') as create_public,
              has_table_privilege('takumo_reader', 'ask_private.secret', 'SELECT') as secret`
    );
    expect(can).toEqual({ create_public: false, secret: false });
  });

  test("a shop's rows never show shop B's values, even where a row points at one", async () => {
    const views = [...new Set(columns.map(([view]) => view))];
    expect(views.length).toBeGreaterThanOrEqual(10);
    const found: string[] = [];
    for (const org of [shopA, shopC]) {
      for (const view of views) {
        const rows = JSON.stringify(await as(org, `select * from ask.${view}`));
        if (leaks(rows)) {
          found.push(`${org === shopA ? "A" : "C"} ${view}: ${rows}`);
        }
      }
    }
    expect(found).toEqual([]);
    // Shop C's own rows are still there, without B's names.
    expect(await as(shopC, "select part_no from ask.parts")).toEqual([
      { part_no: "C-CROSS" },
    ]);
  });

  test("conditions that fail on a value never reveal shop B's (cast and lookup errors)", async () => {
    expect(columns.length).toBeGreaterThan(30);
    const found: string[] = [];
    for (const [view, column] of columns) {
      for (const probe of [
        `"${column}"::int > 0`,
        `"${column}"::regclass is not null`,
        // A zero that depends on the row: 1 / 0 alone fails while planning.
        `case when "${column}" like 'ORGB%' then 1 / (length("${column}") - length("${column}")) else 0 end = 0`,
      ]) {
        for (const hash of [false, true]) {
          const message = await errorOf(() =>
            as(
              shopA,
              `select 1 from ask.${view} where "${column}" not like 'A-%' and ${probe}`,
              hash
            )
          );
          // Shop A has no ORGB values, so a division by zero means the
          // condition ran on one of shop B's.
          if (leaks(message) || message.includes("division by zero")) {
            found.push(
              `${view}.${column} (${probe}, hash=${hash}): ${message}`
            );
          }
        }
      }
    }
    // Division by zero is a yes/no oracle: it must never fire on B's rows.
    expect(found).toEqual([]);
  }, 60_000);

  test("another reader session can't see this one's query text", async () => {
    await reader.query("begin read only");
    const running = reader
      .query(`select pg_sleep(1.5), '${B("SQL")}' as asked`)
      .finally(() => reader.query("rollback"));
    await new Promise((r) => setTimeout(r, 400));
    const seen = await other.query(
      "select query from pg_stat_activity where pid <> pg_backend_pid() and query like '%ORGB-LEAK-SQL%'"
    );
    await running;
    expect(seen.rows).toEqual([]);
  });

  describe("through the app (askQuery)", () => {
    test("off unless ASK_SQL_ENABLED is true: nothing reaches the database", async () => {
      for (const value of [undefined, "", "false", "1", "TRUE"]) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, "ASK_SQL_ENABLED");
        } else {
          process.env.ASK_SQL_ENABLED = value;
        }
        await expect(
          askQuery(admin, shopA, "select name from customers")
        ).rejects.toThrow(ASK_SQL_OFF);
      }
    });

    test("on: shop A gets its own rows", async () => {
      process.env.ASK_SQL_ENABLED = "true";
      const result = await askQuery(
        admin,
        shopA,
        "select name from customers order by name"
      );
      expect(result.rows).toEqual([{ name: "A-CUSTOMER" }]);
    });

    test("on: errors that read a value are never passed on, not even shop A's own", async () => {
      process.env.ASK_SQL_ENABLED = "true";
      for (const sql of [
        "select 1 from customers where name::int > 0",
        "select 1 from parts where customer::regclass is not null",
        "select 1 from routings where work_center::int > 0",
        "select 1 from facts where value::numeric > 0",
        "select 1 / (count(*) - count(*)) from customers",
      ]) {
        const error = await askQuery(admin, shopA, sql).then(
          () => null,
          (e: unknown) => e
        );
        expect(error).toBeInstanceOf(QueryError);
        const { message, ref } = error as InstanceType<typeof QueryError>;
        expect(message).not.toMatch(/A-|ORGB|invalid input|relation "|58213/);
        expect(message).toContain(`ref ${ref}`);
        expect(ref).toMatch(/^[0-9a-f]{8}$/);
      }
    });

    test("on: a condition aimed at shop B's rows finds nothing", async () => {
      process.env.ASK_SQL_ENABLED = "true";
      for (const sql of [
        "select order_no from jobs where order_no not like 'A-%' and order_no::int > 0",
        "select part_no from routings where work_center not like 'A-%' and work_center::int > 0",
        "select customer from orders where customer not like 'A-%' and customer::int > 0",
      ]) {
        await expect(askQuery(admin, shopA, sql)).resolves.toMatchObject({
          rows: [],
        });
      }
    });

    test("on: mistakes in the SQL itself still get a useful message", async () => {
      process.env.ASK_SQL_ENABLED = "true";
      await expect(
        askQuery(admin, shopA, "select no_such_column from customers")
      ).rejects.toThrow(/no_such_column/);
      await expect(
        askQuery(admin, shopA, "select name from no_such_view")
      ).rejects.toThrow(/no_such_view/);
    });

    test("on, but a view without its barrier: off again", async () => {
      process.env.ASK_SQL_ENABLED = "true";
      await admin.$executeRawUnsafe(
        "alter view ask.customers reset (security_barrier)"
      );
      try {
        await expect(
          askQuery(admin, shopA, "select name from customers")
        ).rejects.toThrow(ASK_SQL_OFF);
      } finally {
        await admin.$executeRawUnsafe(
          "alter view ask.customers set (security_barrier = true)"
        );
      }
      await expect(
        askQuery(admin, shopA, "select name from customers")
      ).resolves.toBeTruthy();
    });

    test("pg_stat views and unicode-escaped names are refused before the database", async () => {
      process.env.ASK_SQL_ENABLED = "true";
      await expect(
        askQuery(admin, shopA, "select query from pg_stat_activity")
      ).rejects.toThrow(/pg_stat_activity/);
      await expect(
        askQuery(admin, shopA, `select U&"set\\005fconfig"('a', 'b', true)`)
      ).rejects.toThrow(/escape/i);
    });
  });
});
