// The ERP's employee report and bill of materials, imported into a real
// database (Phase 3, F3.1-R2 and F3.2): employee ids keep people with the
// same name apart, machines are linked by name, shifts are read as people
// write them, and a part learns how much material it uses.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { connect, createTestOrg, importRows, readSeed, TEST_DATABASE_URL } =
  await import("./db-helpers");

describe.skipIf(!TEST_DATABASE_URL)(
  "roster and material per part (database)",
  () => {
    const db = connect();
    let orgId = "";

    beforeAll(async () => {
      orgId = await createTestOrg(db, "roster");
      const { headers, rows } = readSeed("work_centers.csv");
      await importRows(db, orgId, "workCenters", headers, rows);
    });

    afterAll(async () => {
      await db.org.deleteMany({ where: { id: orgId } });
      await db.$disconnect();
    });

    /** Rows keyed by header, as sheets are read. */
    const sheet = (headers: string[], rows: string[][]) =>
      rows.map((r) =>
        Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))
      );

    const ROSTER = [
      "Employee Name",
      "Employee ID",
      "Active",
      "Shift Start",
      "Shift End",
      "Shift Days",
      "Machines",
      "Lights Out",
    ];

    test("people from the employee report, by employee id", async () => {
      const result = await importRows(
        db,
        orgId,
        "operators",
        ROSTER,
        sheet(ROSTER, [
          [
            "Sam Lee",
            "E100",
            "Y",
            "7:00 AM",
            "3:30 PM",
            "Mon-Fri",
            "HAAS-VF2, HAAS-VF4",
            "N",
          ],
          // Same name, different person.
          [
            "Sam Lee",
            "E200",
            "Y",
            "15:30",
            "24:00",
            "Mon-Thu",
            "HAAS-VF2",
            "yes",
          ],
          [
            "Old Timer",
            "E300",
            "inactive",
            "7",
            "15",
            "M-F",
            "HAAS-VF2, SAW-9",
            "",
          ],
        ])
      );
      expect(result.created).toBe(3);
      expect(result.notes.join(" ")).toContain("SAW-9");
      const people = await db.operator.findMany({
        where: { orgId },
        orderBy: { externalId: "asc" },
      });
      expect(people.map((p) => p.externalId)).toEqual(["E100", "E200", "E300"]);
      const [day, second, old] = people;
      expect(day?.shifts).toEqual({
        start: "07:00",
        end: "15:30",
        days: [1, 2, 3, 4, 5],
      });
      expect(second?.shifts).toEqual({
        start: "15:30",
        end: "24:00",
        days: [1, 2, 3, 4],
      });
      expect(second?.canRunUnattended).toBe(true);
      expect(old?.active).toBe(false);
      const machines = await db.workCenter.findMany({
        where: { orgId, name: { in: ["HAAS-VF2", "HAAS-VF4"] } },
        select: { id: true, name: true },
      });
      const id = (name: string) => machines.find((m) => m.name === name)?.id;
      expect(day?.workCenterIds.sort()).toEqual(
        [id("HAAS-VF2"), id("HAAS-VF4")].sort()
      );
      // SAW-9 isn't a machine: left out (and noted), never invented.
      expect(old?.workCenterIds).toEqual([id("HAAS-VF2")]);
    });

    test("tomorrow's report updates the same people, nobody is doubled", async () => {
      const result = await importRows(
        db,
        orgId,
        "operators",
        ROSTER,
        sheet(ROSTER, [
          [
            "Sam Lee",
            "E100",
            "Y",
            "6:00 AM",
            "2:30 PM",
            "Mon-Fri",
            "HAAS-VF2",
            "N",
          ],
          [
            "Sam Lee",
            "E200",
            "N",
            "15:30",
            "24:00",
            "Mon-Thu",
            "HAAS-VF2",
            "yes",
          ],
        ])
      );
      expect(result).toMatchObject({ created: 0, updated: 2 });
      const e100 = await db.operator.findFirst({
        where: { orgId, externalId: "E100" },
      });
      expect(e100?.shifts).toMatchObject({ start: "06:00", end: "14:30" });
      expect(e100?.workCenterIds).toHaveLength(1);
      const e200 = await db.operator.findFirst({
        where: { orgId, externalId: "E200" },
      });
      expect(e200?.active).toBe(false);
      expect(await db.operator.count({ where: { orgId } })).toBe(3);
    });

    test("how much material a part uses, from the bill of materials", async () => {
      await importRows(
        db,
        orgId,
        "parts",
        ["Part Number", "Rev", "Material", "Qty Per", "UOM"],
        sheet(
          ["Part Number", "Rev", "Material", "Qty Per", "UOM"],
          [["BRK-2201", "C", "6061 2in bar", "0.42", "ft"]]
        )
      );
      const part = await db.part.findFirst({
        where: { orgId, partNo: "BRK-2201", rev: "C" },
        include: { material: true },
      });
      expect(part?.materialQtyPerUnit).toBe(0.42);
      expect(part?.materialUnit).toBe("ft");
      expect(part?.material?.name).toBe("6061 2in bar");
    });
  }
);
