import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { connect, createTestOrg, importRows, TEST_DATABASE_URL } = await import(
  "./db-helpers"
);
const { saveRecords } = await import("../save");
const { suggestMapping } = await import("../match");
const { parseRows } = await import("../transform");

describe.skipIf(!TEST_DATABASE_URL)(
  "ERP ids and open operations (database)",
  () => {
    const db = connect();
    let orgId = "";

    beforeAll(async () => {
      orgId = await createTestOrg(db, "erpids");
    });

    afterAll(async () => {
      await db.org.deleteMany({ where: { id: orgId } });
      await db.$disconnect();
    });

    test("a customer renamed in the ERP stays one customer", async () => {
      const headers = ["Cust ID", "Customer Name", "Terms"];
      await importRows(db, orgId, "customers", headers, [
        { "Cust ID": "C-100", "Customer Name": "Acme Corp", Terms: "30" },
      ]);
      const second = await importRows(db, orgId, "customers", headers, [
        {
          "Cust ID": "C-100",
          "Customer Name": "Acme Corporation",
          Terms: "45",
        },
      ]);
      expect(second).toMatchObject({ created: 0, updated: 1 });
      expect(second.notes[0]).toContain("Acme Corp → Acme Corporation");
      const all = await db.customer.findMany({ where: { orgId } });
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        name: "Acme Corporation",
        externalId: "C-100",
        paymentTermDays: 45,
      });
    });

    test("a machine typed in earlier learns its ERP id, then follows renames", async () => {
      await db.workCenter.create({
        data: { orgId, name: "HAAS VF2", shifts: { days: [1, 2, 3] } },
      });
      const headers = ["Machine ID", "Machine", "Hours"];
      await importRows(db, orgId, "workCenters", headers, [
        { "Machine ID": "WC-2", Machine: "haas vf2", Hours: "8" },
      ]);
      await importRows(db, orgId, "workCenters", headers, [
        { "Machine ID": "WC-2", Machine: "HAAS VF-2 #1", Hours: "10" },
      ]);
      const machines = await db.workCenter.findMany({ where: { orgId } });
      expect(machines).toHaveLength(1);
      expect(machines[0]?.name).toBe("HAAS VF-2 #1");
      expect(machines[0]?.externalId).toBe("WC-2");
      // Working days kept; hours from the report.
      expect(machines[0]?.shifts).toEqual({ days: [1, 2, 3], hoursPerDay: 10 });
    });

    test("open operations close finished steps and record parts through", async () => {
      const wc = await db.workCenter.findFirstOrThrow({ where: { orgId } });
      const part = await db.part.create({
        data: { orgId, partNo: "P-9", rev: "A" },
      });
      for (const seq of [10, 20, 30]) {
        await db.routing.create({
          data: {
            orgId,
            partId: part.id,
            seq,
            workCenterId: wc.id,
            setupMin: 30,
            runMinPerUnit: 2,
            altWorkCenterIds: [],
          },
        });
      }
      await db.order.create({
        data: {
          orgId,
          orderNo: "SO-1",
          partId: part.id,
          qty: 100,
          dueDate: new Date("2026-12-01"),
        },
      });
      const headers = ["Job", "Oper", "Qty Complete"];
      const mapping = suggestMapping("operations", headers);
      const parsed = parseRows(
        [
          { Job: "SO-1", Oper: "20", "Qty Complete": "40" },
          { Job: "SO-1", Oper: "30", "Qty Complete": "0" },
          { Job: "SO-404", Oper: "10", "Qty Complete": "0" },
        ],
        mapping
      );
      const syncedAt = new Date("2026-11-05T06:00:00Z");
      const result = await saveRecords(
        db,
        orgId,
        "operations",
        parsed.records,
        {
          syncedAt,
        }
      );
      expect(result).toMatchObject({ created: 2, skipped: 1 });
      expect(result.notes.join(" ")).toContain("SO-404");
      const jobs = await db.job.findMany({
        where: { orgId },
        orderBy: { routingSeq: "asc" },
      });
      expect(
        jobs.map((j) => [j.routingSeq, Boolean(j.closedAt), j.qtyDone])
      ).toEqual([
        // Op 10 isn't on the open-operations report: it's finished.
        [10, true, null],
        [20, false, 40],
        [30, false, 0],
      ]);
      const order = await db.order.findFirstOrThrow({ where: { orgId } });
      expect(order.status).toBe("in_progress");
    });
  }
);
