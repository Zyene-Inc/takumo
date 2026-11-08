import { createHmac, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "../generated/client";

vi.mock("server-only", () => ({}));

// Ask Takumo's read-only SQL (migration 20261031120000_ask_takumo). Needs
// TEST_DATABASE_URL (an admin login) and TEST_ASK_DATABASE_URL (takumo_reader).
const ADMIN = process.env.TEST_DATABASE_URL;
const READER = process.env.TEST_ASK_DATABASE_URL;
process.env.ASK_DATABASE_URL = READER;
process.env.SKIP_ENV_VALIDATION = "true";
// The SQL tool is off by default (security hotfix); these tests use it on.
process.env.ASK_SQL_ENABLED = "true";

const { askQuery, QueryError } = await import("../reader");

describe.skipIf(!(ADMIN && READER))("Ask Takumo reader isolation", () => {
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: ADMIN ?? "" }),
  });
  const reader = new pg.Client({ connectionString: READER });
  const shopA = `org_test_a_${randomUUID().slice(0, 8)}`;
  const shopB = `org_test_b_${randomUUID().slice(0, 8)}`;
  let secret = "";

  const sign = (org: string) =>
    createHmac("sha256", secret).update(org).digest("hex");

  /** Raw reader access, skipping the app's SQL check: what the database allows. */
  const raw = async (org: string, signature: string, sql: string) => {
    await reader.query("begin");
    try {
      await reader.query(
        "select set_config('takumo.org_id', $1, true), set_config('takumo.org_sig', $2, true)",
        [org, signature]
      );
      return (await reader.query(sql)).rows;
    } finally {
      await reader.query("rollback");
    }
  };

  beforeAll(async () => {
    await reader.connect();
    [{ value: secret }] = await admin.$queryRawUnsafe<{ value: string }[]>(
      "select value from ask_private.secret"
    );
    for (const [org, orderNo] of [
      [shopA, "A-1"],
      [shopB, "B-1"],
    ]) {
      await admin.org.create({ data: { id: org, name: org } });
      const part = await admin.part.create({
        data: { orgId: org, partNo: `P-${orderNo}` },
      });
      await admin.order.create({
        data: {
          orgId: org,
          orderNo,
          partId: part.id,
          qty: 5,
          dueDate: new Date("2026-12-01"),
        },
      });
    }
  });

  afterAll(async () => {
    await admin.org.deleteMany({ where: { id: { in: [shopA, shopB] } } });
    await admin.$disconnect();
    await reader.end();
  });

  test("a shop sees only its own rows", async () => {
    const a = await askQuery(
      admin,
      shopA,
      "select order_no, part_no, qty, due_date from orders"
    );
    expect(a.rows).toEqual([
      { order_no: "A-1", part_no: "P-A-1", qty: 5, due_date: "2026-12-01" },
    ]);
    const b = await askQuery(admin, shopB, "select order_no from orders");
    expect(b.rows).toEqual([{ order_no: "B-1" }]);
  });

  test("the app's check stops obvious misuse with a clear message", async () => {
    await expect(askQuery(admin, shopA, "delete from orders")).rejects.toThrow(
      QueryError
    );
    await expect(
      askQuery(
        admin,
        shopA,
        `select set_config('takumo.org_id', '${shopB}', true)`
      )
    ).rejects.toThrow(/set_config/);
  });

  test("a forged or rewritten shop id sees nothing", async () => {
    expect(
      await raw(shopB, "forged", "select count(*)::int as n from orders")
    ).toEqual([{ n: 0 }]);
    const rewritten = await raw(
      shopA,
      sign(shopA),
      `select set_config('takumo.org_id', '${shopB}', true), (select count(*)::int from orders) as n`
    );
    expect(rewritten[0].n).toBe(0);
  });

  test("the reader can't reach tables, the secret, or other roles, or write", async () => {
    const attempts = [
      'select * from public."Order"',
      "select * from ask_private.secret",
      "select set_config('role', 'postgres', true)",
      "create temp table x (a int)",
    ];
    for (const sql of attempts) {
      await expect(raw(shopA, sign(shopA), sql)).rejects.toThrow();
    }
  });

  test("long queries are cancelled", async () => {
    await expect(raw(shopA, sign(shopA), "select pg_sleep(6)")).rejects.toThrow(
      /timeout/
    );
  }, 15_000);
});
