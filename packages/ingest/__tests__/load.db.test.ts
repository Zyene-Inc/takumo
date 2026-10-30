import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { connect, createTestOrg, importRows, TEST_DATABASE_URL } = await import(
  "./db-helpers"
);

// A large job shop: 40 machines, 2,500 parts with 4 operations each, 3,000
// open orders and 5,000 past quotes. Run with `pnpm test:load` and
// TEST_DATABASE_URL set; prints how long each upload takes.
const MACHINES = 40;
const PARTS = 2500;
const OPS_PER_PART = 4;
const ORDERS = 3000;
const QUOTES = 5000;
// Generous ceiling per upload; the goal is a whole shop in well under an hour.
const MAX_SECONDS_PER_UPLOAD = 180;

const machine = (i: number) => `WC-${String(i % MACHINES).padStart(2, "0")}`;
const partNo = (i: number) => `LP-${String(i).padStart(5, "0")}`;
const customer = (i: number) => `Customer ${i % 60}`;
const date = (i: number) => {
  const d = new Date(Date.UTC(2026, 10, 1) + (i % 120) * 86_400_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
};

describe.skipIf(!(TEST_DATABASE_URL && process.env.LOAD_TEST))(
  "large shop import (load)",
  () => {
    const db = connect();
    let orgId = "";
    const timings: Record<string, string> = {};

    beforeAll(async () => {
      orgId = await createTestOrg(db, "load");
    });

    afterAll(async () => {
      await db.org.deleteMany({ where: { id: orgId } });
      await db.$disconnect();
      console.table(timings);
    });

    const timed = async (
      label: string,
      rows: number,
      run: () => Promise<{ created: number }>
    ) => {
      const start = performance.now();
      const result = await run();
      const seconds = (performance.now() - start) / 1000;
      timings[label] =
        `${rows.toLocaleString()} rows in ${seconds.toFixed(1)} s (${Math.round(rows / seconds)}/s)`;
      expect(seconds).toBeLessThan(MAX_SECONDS_PER_UPLOAD);
      return result;
    };

    test("machines", async () => {
      const rows = Array.from({ length: MACHINES }, (_, i) => ({
        Machine: machine(i),
        Type: i % 3 === 0 ? "cnc_lathe" : "cnc_mill",
        Rate: `$${90 + (i % 5) * 10}`,
        "Hrs/Day": 16,
      }));
      const r = await timed("machines", rows.length, () =>
        importRows(db, orgId, "workCenters", Object.keys(rows[0]), rows)
      );
      expect(r.created).toBe(MACHINES);
    }, 600_000);

    test("parts", async () => {
      const rows = Array.from({ length: PARTS }, (_, i) => ({
        "Part Number": partNo(i),
        Rev: "A",
        Description: `Bracket ${i}`,
        Customer: customer(i),
        Material: `Stock ${i % 25}`,
      }));
      const r = await timed("parts", rows.length, () =>
        importRows(db, orgId, "parts", Object.keys(rows[0]), rows)
      );
      expect(r.created).toBe(PARTS);
    }, 600_000);

    test("routings", async () => {
      const rows = Array.from({ length: PARTS * OPS_PER_PART }, (_, i) => ({
        "Part #": partNo(Math.floor(i / OPS_PER_PART)),
        "Op #": ((i % OPS_PER_PART) + 1) * 10,
        Machine: machine(i * 7),
        "Setup (min)": 30 + (i % 4) * 15,
        "Run (min)": 2 + (i % 9),
      }));
      const r = await timed("routings", rows.length, () =>
        importRows(db, orgId, "routings", Object.keys(rows[0]), rows)
      );
      expect(r.created).toBe(PARTS * OPS_PER_PART);
    }, 600_000);

    test("open orders", async () => {
      const rows = Array.from({ length: ORDERS }, (_, i) => ({
        "Job #": `J-${100_000 + i}`,
        "Part Number": partNo(i % PARTS),
        Qty: 50 + (i % 400),
        "Ship Date": date(i),
        Customer: customer(i),
        "Ext Price": `$${(1000 + i * 3).toLocaleString()}`,
      }));
      const r = await timed("orders", rows.length, () =>
        importRows(db, orgId, "orders", Object.keys(rows[0]), rows)
      );
      expect(r.created).toBe(ORDERS);
    }, 600_000);

    test("past quotes", async () => {
      const rows = Array.from({ length: QUOTES }, (_, i) => ({
        "Quote #": `Q-${200_000 + i}`,
        Customer: customer(i),
        "Part Number": partNo(i % PARTS),
        Qty: 25 + (i % 500),
        Price: 500 + i,
        Status: ["Won", "Lost", "Sent"][i % 3],
        Date: date(i),
      }));
      const r = await timed("quotes", rows.length, () =>
        importRows(db, orgId, "quotes", Object.keys(rows[0]), rows)
      );
      expect(r.created).toBe(QUOTES);
    }, 600_000);
  }
);
