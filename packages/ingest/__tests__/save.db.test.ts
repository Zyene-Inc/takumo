import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { connect, createTestOrg, importRows, readSeed, TEST_DATABASE_URL } =
  await import("./db-helpers");

describe.skipIf(!TEST_DATABASE_URL)("saving imports (database)", () => {
  const db = connect();
  let orgId = "";
  let otherOrgId = "";

  const importSeed = (
    entity: Parameters<typeof importRows>[2],
    file: string,
    org = orgId
  ) => {
    const { headers, rows } = readSeed(file);
    return importRows(db, org, entity, headers, rows);
  };

  beforeAll(async () => {
    orgId = await createTestOrg(db, "save");
    otherOrgId = await createTestOrg(db, "other");
  });

  afterAll(async () => {
    // Deleting the org cascades to everything it owns.
    await db.org.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    expect(await db.part.count({ where: { orgId } })).toBe(0);
    await db.$disconnect();
  });

  test("imports the demo shop in dependency order", async () => {
    expect(await importSeed("workCenters", "work_centers.csv")).toMatchObject({
      created: 5,
      updated: 0,
    });
    await importSeed("customers", "customers.csv");
    await importSeed("materials", "materials.csv");
    expect(await importSeed("parts", "parts.csv")).toMatchObject({
      created: 6,
    });
    expect(await importSeed("routings", "routings.csv")).toMatchObject({
      created: 13,
      notes: [],
    });
    expect(await importSeed("orders", "orders.csv")).toMatchObject({
      created: 6,
    });
    expect(await importSeed("quotes", "quotes.csv")).toMatchObject({
      created: 8,
    });

    const routing = await db.routing.findFirst({
      where: { orgId, seq: 10, part: { partNo: "P-1001" } },
      include: { workCenter: true },
    });
    expect(routing).toMatchObject({ setupMin: 45, runMinPerUnit: 6 });
    expect(routing?.workCenter.name).toBe("HAAS-VF2");
    expect(routing?.altWorkCenterIds).toHaveLength(1);
  });

  test("job history: closed orders added, planned times kept for calibration", async () => {
    const result = await importSeed("jobs", "jobs.csv");
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ created: 52, updated: 0 });
    expect(result.notes.join(" ")).toMatch(
      /Closed orders added from the job history: SO-4901/
    );
    const order = await db.order.findFirst({
      where: { orgId, orderNo: "SO-4901" },
    });
    expect(order?.status).toBe("done");
    const job = await db.job.findFirst({
      where: { orgId, order: { orderNo: "SO-4901" }, routingSeq: 10 },
      include: { order: true },
    });
    // The lathe setup really took 122 min; the routing says 90.
    expect(job).toMatchObject({
      actualSetupMin: 122,
      actualRunMin: 759.6,
      qtyGood: 58,
      qtyScrap: 2,
      plannedSetupMin: 90,
      plannedRunMinPerUnit: 12,
    });
    // Open orders are untouched.
    expect(await db.order.count({ where: { orgId, status: "open" } })).toBe(6);
    // Importing it again updates in place.
    expect(await importSeed("jobs", "jobs.csv")).toMatchObject({
      created: 0,
      updated: 52,
    });
  }, 60_000);

  test("re-importing the same file updates instead of duplicating", async () => {
    const again = await importSeed("workCenters", "work_centers.csv");
    expect(again).toMatchObject({ created: 0, updated: 5 });
    expect(await db.workCenter.count({ where: { orgId } })).toBe(5);
    expect(await importSeed("orders", "orders.csv")).toMatchObject({
      created: 0,
      updated: 6,
    });
  });

  test("a partial re-upload doesn't blank out other fields", async () => {
    await importRows(
      db,
      orgId,
      "workCenters",
      ["Machine", "Shop Rate"],
      [{ Machine: "HAAS-VF2", "Shop Rate": "$120" }]
    );
    const machine = await db.workCenter.findFirst({
      where: { orgId, name: "HAAS-VF2" },
    });
    expect(Number(machine?.hourlyRate)).toBe(120);
    expect(machine?.type).toBe("cnc_mill");
    expect(machine?.efficiency).toBeCloseTo(0.9);
  });

  test("references to unknown records are created and reported", async () => {
    const routings = await importRows(
      db,
      orgId,
      "routings",
      ["Part #", "Op #", "Machine", "Setup (hrs)", "Cycle Time"],
      [
        {
          "Part #": "P-9001",
          "Op #": 10,
          Machine: "MAZAK-QTN",
          "Setup (hrs)": 1.5,
          "Cycle Time": 8,
        },
      ]
    );
    expect(routings.notes.join(" ")).toContain("MAZAK-QTN");
    expect(routings.notes.join(" ")).toContain("P-9001");
    const machine = await db.workCenter.findFirst({
      where: { orgId, name: "MAZAK-QTN" },
    });
    expect(machine?.provenance).toBe("assumed");
    const op = await db.routing.findFirst({
      where: { orgId, part: { partNo: "P-9001" } },
    });
    expect(op?.setupMin).toBe(90);

    const orders = await importRows(
      db,
      orgId,
      "orders",
      ["SO", "Part", "Qty", "Due", "Customer"],
      [
        {
          SO: "SO-NEW",
          Part: "P-9002",
          Qty: 5,
          Due: "12/01/2026",
          Customer: "Kestrel Aerospace",
        },
      ]
    );
    expect(orders.created).toBe(1);
    expect(orders.notes.join(" ")).toContain("Kestrel Aerospace");
    const part = await db.part.findFirst({
      where: { orgId, partNo: "P-9002" },
    });
    expect(part?.rev).toBe("A");
  });

  test("duplicate rows in one file: the last one wins", async () => {
    const result = await importRows(
      db,
      orgId,
      "customers",
      ["Customer", "Terms"],
      [
        { Customer: "Dup Co", Terms: "Net 30" },
        { Customer: "Dup Co", Terms: "Net 45" },
      ]
    );
    expect(result).toMatchObject({ created: 1, skipped: 1 });
    const customer = await db.customer.findFirst({
      where: { orgId, name: "Dup Co" },
    });
    expect(customer?.paymentTermDays).toBe(45);
  });

  test("manual edits are marked as stated", async () => {
    await importRows(
      db,
      orgId,
      "workCenters",
      ["name", "hourlyRate"],
      [{ name: "MAZAK-QTN", hourlyRate: "115" }],
      "stated"
    );
    const machine = await db.workCenter.findFirst({
      where: { orgId, name: "MAZAK-QTN" },
    });
    expect(machine?.provenance).toBe("stated");
  });

  test("shops never see or overwrite each other's data", async () => {
    // Same machine names in another shop are separate records.
    expect(
      await importSeed("workCenters", "work_centers.csv", otherOrgId)
    ).toMatchObject({ created: 5, updated: 0 });
    await importRows(
      db,
      otherOrgId,
      "workCenters",
      ["Machine", "Shop Rate"],
      [{ Machine: "HAAS-VF2", "Shop Rate": "999" }]
    );
    const mine = await db.workCenter.findFirst({
      where: { orgId, name: "HAAS-VF2" },
    });
    expect(Number(mine?.hourlyRate)).toBe(120);
    // Orders in the other shop resolve to that shop's parts only.
    await importRows(
      db,
      otherOrgId,
      "orders",
      ["SO", "Part", "Qty", "Due"],
      [{ SO: "SO-X", Part: "P-1001", Qty: 1, Due: "2026-12-01" }]
    );
    const order = await db.order.findFirst({
      where: { orgId: otherOrgId, orderNo: "SO-X" },
      include: { part: true },
    });
    expect(order?.part.orgId).toBe(otherOrgId);
  });
});
