import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.SKIP_ENV_VALIDATION = "true";

const { allowSql } = await import("../sql-allow");
const { queryFailure } = await import("../reader");
const { QueryError } = await import("../sql-guard");

// Ask Takumo's SQL allowlist (sql-allow.ts), on Postgres's own parse tree.
// What the agent needs passes as written; what it never needs (catalogs,
// functions that run queries of their own, settings, regclass-style casts,
// anything but one SELECT) is refused before it reaches the database.

const refused = async (sql: string) => {
  try {
    await allowSql(sql);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return (error as Error).message;
  }
};

describe("allowed: what the agent needs", () => {
  test.each([
    "select name from customers",
    "select * from ask.parts",
    "select p.part_no, count(*) filter (where o.qty > 1) as n, extract(year from o.due_date)::int as y, round(avg(o.price)::numeric, 2) from parts p join orders o using (part_no) where o.customer ilike '%acme%' and o.status in ('open', 'late') group by 1, 3 order by 2 desc limit 5",
    "with late as (select order_no, due_date from orders where due_date < '2026-11-01') select count(*) from late",
    "select date_trunc('month', due_date) as m, sum(qty * price) from orders group by 1 order by 1",
    "select work_center, sum(available_hours) filter (where reason is null) from calendar group by work_center",
    "select part_no, rank() over (partition by customer order by qty desc) from orders",
    "select percentile_cont(0.5) within group (order by price) from quotes",
    "select extract(epoch from (actual_end - actual_start)) / 60 from jobs",
    "select g::date from generate_series('2026-11-01'::date, '2026-11-07', interval '1 day') as g",
    "select coalesce(customer, 'none'), nullif(qty, 0), greatest(1, 2), case when qty > 5 then 'big' else 'small' end from orders",
    "select order_no from orders where part_no = any(array['A', 'B']) and due_date between '2026-11-01' and '2026-11-30'",
    "select exists (select 1 from jobs where pinned)",
    "select o.order_no from orders o left join jobs j on j.order_no = o.order_no where j.order_no is null",
    "select now() - interval '7 days', current_date",
    "select name from customers where name = 'O''Brien' or name = $$x$$",
    "select fact_no, value from facts where status = 'approved'",
    "select string_agg(distinct work_center, ', ' order by work_center) from routings",
    "select unnest(alt_work_centers) from routings",
    "select to_char(due_date, 'YYYY-MM'), lower(customer), split_part(part_no, '-', 1) from orders",
  ])("%s", async (sql) => {
    expect(await allowSql(sql)).toBe(sql);
  });

  test("the statement is sent exactly as written, without a trailing semicolon", async () => {
    expect(await allowSql("select '--' as a, name from customers;")).toBe(
      "select '--' as a, name from customers"
    );
    expect(await allowSql("-- totals\nselect count(*) from orders ;  ")).toBe(
      "-- totals\nselect count(*) from orders"
    );
    expect(await allowSql("select 'Müller ✓' as n from customers;")).toBe(
      "select 'Müller ✓' as n from customers"
    );
  });
});

describe("refused: what the agent never needs", () => {
  test.each([
    // system catalogs, other schemas, base tables
    ["select query from pg_stat_activity", /"pg_stat_activity" can't be read/],
    [
      'select * from U&"pg\\005fstat\\005factivity"',
      /"pg_stat_activity" can't be read/,
    ],
    ["select reltuples from pg_catalog.pg_class", /can't be read/],
    ["select * from information_schema.tables", /can't be read/],
    ['select * from public."Part"', /can't be read/],
    ['select * from "Part"', /"Part" can't be read/],
    ["select value from ask_private.secret", /can't be read/],
    ["select * from extensions.pg_stat_statements", /can't be read/],
    [
      "select 1 from customers where (select count(*) from pg_class) > 0",
      /"pg_class" can't be read/,
    ],
    ["with x as (select 1) select * from x, pg_stat_activity", /can't be read/],
    ["with pg_class as (select 1) select * from pg_class", /another name/],
    // functions that run a query of their own, settings, sleeps, internals
    [
      "select query_to_xml('select query from pg_stat_activity', true, false, '')",
      /query_to_xml\(\) isn't allowed/,
    ],
    ["select table_to_xml('ask.parts', true, false, '')", /table_to_xml/],
    ["select * from ts_stat('select 1')", /ts_stat/],
    ["select cursor_to_xml(null, 1, true, false, '')", /cursor_to_xml/],
    ["select database_to_xml(true, false, '')", /database_to_xml/],
    ["select current_setting('takumo.org_sig')", /current_setting/],
    ["select set_config('takumo.org_id', 'x', true)", /set_config/],
    ["select U&\"set\\005fconfig\"('a', 'b', true)", /set_config/],
    ["select pg_sleep(1)", /pg_sleep/],
    ["select pg_advisory_lock(1)", /pg_advisory_lock/],
    ["select ask_private.org_id()", /ask_private\.org_id/],
    ["select ask_private.run('select 1', 1)", /ask_private\.run/],
    ["select pg_catalog.pg_get_viewdef('ask.parts'::text)", /pg_get_viewdef/],
    ["select lo_get(1)", /lo_get/],
    ["select version()", /version/],
    // casts that look things up
    ["select name::regclass from customers", /Casting to regclass/],
    ["select 'x'::pg_catalog.regtype", /regtype/],
    ["select cast(name as regnamespace) from customers", /regnamespace/],
    ["select name::xml from customers", /xml/],
    // other kinds of SQL
    ["select xmlelement(name a)", /This kind of SQL/],
    ["select * from customers for update", /lockingClause/],
    ["select * into t from customers", /intoClause/],
    ["select * from customers tablesample system (10)", /This kind of SQL/],
    ["select $1", /This kind of SQL/],
    ["select 1 operator(public.+) 1", /built-in operators/],
    ["insert into customers (name) values ('x')", /Only SELECT/],
    [
      "with x as (delete from orders returning *) select * from x",
      /This kind of SQL/,
    ],
    ["explain select 1", /Only SELECT/],
    ["set role postgres", /Only SELECT/],
    ["do $$ begin end $$", /Only SELECT/],
    ["select 1; select 2", /one SELECT statement at a time/],
    ["", /empty/],
    ["select from where", /syntax error near character/],
    [`select '${"x".repeat(10_001)}'`, /under 10,000 characters/],
  ] as [string, RegExp][])("%s", async (sql, message) => {
    expect(await refused(sql)).toMatch(message);
  });
});

describe("database errors are never passed on", () => {
  const SECRET = "ORGB-SECRET-71640";
  test.each([
    "42601",
    "42703",
    "42P01",
    "42883",
    "42704",
    "0A000",
    "22P02",
    "22012",
    "21000",
    "57014",
    "XX000",
    undefined,
  ])("SQLSTATE %s", (code) => {
    const error = Object.assign(
      new Error(`relation "${SECRET}" does not exist`),
      {
        code,
        detail: SECRET,
        hint: SECRET,
        position: "12",
        where: SECRET,
      }
    );
    const failed = queryFailure(error);
    expect(failed).toBeInstanceOf(QueryError);
    expect(failed.message).not.toContain(SECRET);
    expect(failed.message).not.toMatch(/does not exist|relation/);
    expect(failed.message).toMatch(/\(ref [0-9a-f]{8}\)$/);
    expect(failed.sqlState).toBe(code);
    expect(failed.stage).toBe("run");
  });
});
