// Loads the demo shop in seed/acme-precision into one org.
// Usage: SEED_ORG_ID=org_xxx pnpm db:seed   (your WorkOS organization ID, org_…)
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";

const SEED_DIR = join(import.meta.dirname, "../../../seed/acme-precision");

const orgId = process.env.SEED_ORG_ID;
if (!orgId) {
  throw new Error("Set SEED_ORG_ID to your WorkOS organization ID");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});

// The seed files contain no quoted commas, so a simple split is enough.
const readCsv = (file: string): Record<string, string>[] => {
  const [header, ...rows] = readFileSync(join(SEED_DIR, file), "utf8")
    .trim()
    .split("\n");
  const columns = header.split(",");
  return rows.map((row) => {
    const values = row.split(",");
    return Object.fromEntries(columns.map((c, i) => [c, values[i] ?? ""]));
  });
};

const optionalNumber = (value: string) => (value === "" ? null : Number(value));

const main = async () => {
  await prisma.org.upsert({
    where: { id: orgId },
    create: { id: orgId, name: "Acme Precision" },
    update: {},
  });

  const workCenters = new Map<string, string>();
  for (const row of readCsv("work_centers.csv")) {
    const wc = await prisma.workCenter.upsert({
      where: { orgId_name: { orgId, name: row.name } },
      create: {
        orgId,
        name: row.name,
        type: row.type,
        hourlyRate: Number(row.hourly_rate),
        efficiency: Number(row.efficiency),
        shifts: { hoursPerDay: Number(row.hours_per_day) },
      },
      update: {},
    });
    workCenters.set(row.name, wc.id);
  }

  const customers = new Map<string, string>();
  for (const row of readCsv("customers.csv")) {
    const c = await prisma.customer.upsert({
      where: { orgId_name: { orgId, name: row.name } },
      create: {
        orgId,
        name: row.name,
        paymentTermDays: Number(row.payment_term_days),
      },
      update: {},
    });
    customers.set(row.name, c.id);
  }

  const materials = new Map<string, string>();
  for (const row of readCsv("materials.csv")) {
    const m = await prisma.material.upsert({
      where: { orgId_name: { orgId, name: row.name } },
      create: {
        orgId,
        name: row.name,
        spec: row.spec,
        unitCost: Number(row.unit_cost),
        unit: row.unit,
        leadTimeDays: Number(row.lead_time_days),
      },
      update: {},
    });
    materials.set(row.name, m.id);
  }

  const parts = new Map<string, string>();
  for (const row of readCsv("parts.csv")) {
    const p = await prisma.part.upsert({
      where: { orgId_partNo_rev: { orgId, partNo: row.part_no, rev: row.rev } },
      create: {
        orgId,
        partNo: row.part_no,
        rev: row.rev,
        description: row.description,
        customerId: customers.get(row.customer),
        materialId: materials.get(row.material),
      },
      update: {},
    });
    parts.set(row.part_no, p.id);
  }

  for (const row of readCsv("routings.csv")) {
    const partId = parts.get(row.part_no);
    const workCenterId = workCenters.get(row.work_center);
    if (!(partId && workCenterId)) {
      continue;
    }
    await prisma.routing.upsert({
      where: { partId_seq: { partId, seq: Number(row.seq) } },
      create: {
        orgId,
        partId,
        seq: Number(row.seq),
        workCenterId,
        setupMin: Number(row.setup_min),
        runMinPerUnit: Number(row.run_min_per_unit),
        altWorkCenterIds: row.alt_work_centers
          .split("|")
          .filter(Boolean)
          .map((name) => workCenters.get(name))
          .filter((id): id is string => Boolean(id)),
      },
      update: {},
    });
  }

  for (const row of readCsv("orders.csv")) {
    await prisma.order.upsert({
      where: { orgId_orderNo: { orgId, orderNo: row.order_no } },
      create: {
        orgId,
        orderNo: row.order_no,
        customerId: customers.get(row.customer),
        partId: parts.get(row.part_no) ?? "",
        qty: Number(row.qty),
        dueDate: new Date(row.due_date),
        price: Number(row.price),
        priority: Number(row.priority),
      },
      update: {},
    });
  }

  for (const row of readCsv("quotes.csv")) {
    await prisma.quote.upsert({
      where: { orgId_quoteNo: { orgId, quoteNo: row.quote_no } },
      create: {
        orgId,
        quoteNo: row.quote_no,
        customerId: customers.get(row.customer),
        partId: parts.get(row.part_no),
        qty: Number(row.qty),
        price: Number(row.price),
        leadTimeDays: Number(row.lead_time_days),
        estCost: optionalNumber(row.est_cost),
        actualCost: optionalNumber(row.actual_cost),
        status: row.status as "open" | "won" | "lost",
        quotedAt: new Date(row.quoted_at),
      },
      update: {},
    });
  }

  // Six weeks of finished operations (closed orders), for calibration.
  const routings = new Map(
    (
      await prisma.routing.findMany({
        where: { orgId },
        select: {
          partId: true,
          seq: true,
          setupMin: true,
          runMinPerUnit: true,
        },
      })
    ).map((r) => [`${r.partId}|${r.seq}`, r])
  );
  for (const row of readCsv("jobs.csv")) {
    const partId = parts.get(row.part_no) ?? "";
    const good = Number(row.qty_good);
    const scrap = Number(row.qty_scrap);
    const order = await prisma.order.upsert({
      where: { orgId_orderNo: { orgId, orderNo: row.order_no } },
      create: {
        orgId,
        orderNo: row.order_no,
        partId,
        qty: good + scrap,
        dueDate: new Date(row.finished_on),
        status: "done",
      },
      update: {},
    });
    const seq = Number(row.seq);
    const setupMin = Number(row.setup_min);
    const runMin = Number(row.run_min);
    const end = new Date(`${row.finished_on}T15:00:00Z`);
    const routing = routings.get(`${partId}|${seq}`);
    await prisma.job.upsert({
      where: { orderId_routingSeq: { orderId: order.id, routingSeq: seq } },
      create: {
        orgId,
        orderId: order.id,
        routingSeq: seq,
        workCenterId: workCenters.get(row.work_center),
        actualStart: new Date(end.getTime() - (setupMin + runMin) * 60_000),
        actualEnd: end,
        actualSetupMin: setupMin,
        actualRunMin: runMin,
        qtyGood: good,
        qtyScrap: scrap,
        plannedSetupMin: routing?.setupMin ?? null,
        plannedRunMinPerUnit: routing?.runMinPerUnit ?? null,
      },
      update: {},
    });
  }

  console.log(`Seeded Acme Precision into org ${orgId}`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
