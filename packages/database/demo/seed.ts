// Loads the demo shop (Acme Precision, seed/acme-precision) into one org.
// Used by `pnpm db:seed` (dates as they are, for the evals) and by "Create a
// demo shop" in the app (dates moved so the shop looks current).
import type { PrismaClient } from "../generated/client";
import { DEMO } from "./data";

/** The demo's "today": open orders are due in the weeks after it. */
export const DEMO_TODAY = "2026-11-02";

const DAY_MS = 86_400_000;

const optionalNumber = (value: string) => (value === "" ? null : Number(value));

/** Days to move every demo date so DEMO_TODAY lands on `today`. */
export const demoShiftDays = (today: string) =>
  Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${DEMO_TODAY}T00:00:00Z`)) /
      DAY_MS
  );

export const seedDemoShop = async (
  prisma: PrismaClient,
  orgId: string,
  { shiftDays = 0 }: { shiftDays?: number } = {}
) => {
  const at = (date: string, time = "00:00:00") =>
    new Date(Date.parse(`${date}T${time}Z`) + shiftDays * DAY_MS);

  const workCenters = new Map<string, string>();
  for (const row of DEMO.workCenters) {
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
  for (const row of DEMO.customers) {
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
  for (const row of DEMO.materials) {
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
  for (const row of DEMO.parts) {
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

  const routings = new Map<
    string,
    { setupMin: number; runMinPerUnit: number }
  >();
  for (const row of DEMO.routings) {
    const partId = parts.get(row.part_no);
    const workCenterId = workCenters.get(row.work_center);
    if (!(partId && workCenterId)) {
      continue;
    }
    const r = await prisma.routing.upsert({
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
    routings.set(`${partId}|${row.seq}`, r);
  }

  for (const row of DEMO.orders) {
    await prisma.order.upsert({
      where: { orgId_orderNo: { orgId, orderNo: row.order_no } },
      create: {
        orgId,
        orderNo: row.order_no,
        customerId: customers.get(row.customer),
        partId: parts.get(row.part_no) ?? "",
        qty: Number(row.qty),
        dueDate: at(row.due_date),
        price: Number(row.price),
        priority: Number(row.priority),
      },
      update: {},
    });
  }

  for (const row of DEMO.quotes) {
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
        quotedAt: at(row.quoted_at),
      },
      update: {},
    });
  }

  // Six weeks of finished operations (closed orders), for calibration.
  for (const row of DEMO.jobs) {
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
        dueDate: at(row.finished_on),
        status: "done",
      },
      update: {},
    });
    const seq = Number(row.seq);
    const setupMin = Number(row.setup_min);
    const runMin = Number(row.run_min);
    const end = at(row.finished_on, "15:00:00");
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
};

/** The demo's documents (setup notes, quality manual), by file name. */
export const DEMO_DOCS: Record<string, string> = DEMO.docs;
