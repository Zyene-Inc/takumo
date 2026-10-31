import "server-only";

import { database, forOrg } from "@repo/database";
import { entityCsv, plainCsv, zipFiles } from "./csv";

const num = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

const README = `Takumo data export

The first eight files use the same columns as Takumo's import templates, so
they can be uploaded again (Set up your shop → upload) in this order:
work_centers, customers, materials, parts, routings, orders, quotes, jobs.

Times are in minutes. Dates are YYYY-MM-DD. Money is in US dollars.

facts.csv    what your people taught Takumo, with history and review
notes.csv    voice and typed notes from the floor
rfqs.csv     requests for quote received and what happened to them
`;

/** Everything a shop has put into Takumo, as a zip of CSV files. */
export const exportShop = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const [
    workCenters,
    customers,
    materials,
    parts,
    routings,
    orders,
    quotes,
    jobs,
    facts,
    notes,
    rfqs,
  ] = await Promise.all([
    db.workCenter.findMany({ orderBy: { name: "asc" } }),
    db.customer.findMany({ orderBy: { name: "asc" } }),
    db.material.findMany({ orderBy: { name: "asc" } }),
    db.part.findMany({
      orderBy: [{ partNo: "asc" }, { rev: "asc" }],
      include: {
        customer: { select: { name: true } },
        material: { select: { name: true } },
      },
    }),
    db.routing.findMany({
      orderBy: [{ part: { partNo: "asc" } }, { seq: "asc" }],
      include: {
        part: { select: { partNo: true, rev: true } },
        workCenter: { select: { name: true } },
      },
    }),
    db.order.findMany({
      orderBy: { orderNo: "asc" },
      include: {
        part: { select: { partNo: true } },
        customer: { select: { name: true } },
      },
    }),
    db.quote.findMany({
      orderBy: { quoteNo: "asc" },
      include: {
        part: { select: { partNo: true } },
        customer: { select: { name: true } },
      },
    }),
    db.job.findMany({
      where: { actualEnd: { not: null } },
      orderBy: { actualEnd: "asc" },
      include: {
        order: {
          select: { orderNo: true, part: { select: { partNo: true } } },
        },
      },
    }),
    db.fact.findMany({ orderBy: { number: "asc" } }),
    db.note.findMany({ orderBy: { createdAt: "asc" } }),
    db.rfq.findMany({
      orderBy: { number: "asc" },
      include: {
        lines: { select: { partNo: true, qtys: true } },
        quotes: { select: { quoteNo: true } },
      },
    }),
  ]);
  const machineName = new Map(workCenters.map((w) => [w.id, w.name]));

  return zipFiles({
    "README.txt": README,
    "work_centers.csv": entityCsv(
      "workCenters",
      workCenters.map((w) => ({
        name: w.name,
        type: w.type,
        hourlyRate: num(w.hourlyRate),
        efficiency: w.efficiency,
        hoursPerDay:
          (w.shifts as { hoursPerDay?: number } | null)?.hoursPerDay ?? null,
      }))
    ),
    "customers.csv": entityCsv(
      "customers",
      customers.map((c) => ({
        name: c.name,
        paymentTermDays: c.paymentTermDays,
      }))
    ),
    "materials.csv": entityCsv(
      "materials",
      materials.map((m) => ({
        name: m.name,
        spec: m.spec,
        unitCost: num(m.unitCost),
        unit: m.unit,
        leadTimeDays: m.leadTimeDays,
      }))
    ),
    "parts.csv": entityCsv(
      "parts",
      parts.map((p) => ({
        partNo: p.partNo,
        rev: p.rev,
        description: p.description,
        customer: p.customer?.name,
        material: p.material?.name,
      }))
    ),
    "routings.csv": entityCsv(
      "routings",
      routings.map((r) => ({
        partNo: r.part.partNo,
        rev: r.part.rev,
        seq: r.seq,
        workCenter: r.workCenter.name,
        setupMin: r.setupMin,
        runMinPerUnit: r.runMinPerUnit,
        altWorkCenters: r.altWorkCenterIds
          .map((id) => machineName.get(id))
          .filter(Boolean)
          .join("|"),
      }))
    ),
    "orders.csv": entityCsv(
      "orders",
      orders.map((o) => ({
        orderNo: o.orderNo,
        partNo: o.part.partNo,
        qty: o.qty,
        dueDate: day(o.dueDate),
        customer: o.customer?.name,
        price: num(o.price),
        priority: o.priority,
        status: o.status,
      }))
    ),
    "quotes.csv": entityCsv(
      "quotes",
      quotes.map((q) => ({
        quoteNo: q.quoteNo,
        qty: q.qty,
        customer: q.customer?.name,
        partNo: q.part?.partNo,
        price: num(q.price),
        leadTimeDays: q.leadTimeDays,
        estCost: num(q.estCost),
        actualCost: num(q.actualCost),
        status: q.status,
        quotedAt: day(q.quotedAt),
      }))
    ),
    "jobs.csv": entityCsv(
      "jobs",
      jobs.map((j) => ({
        orderNo: j.order.orderNo,
        partNo: j.order.part.partNo,
        seq: j.routingSeq,
        workCenter: j.workCenterId ? machineName.get(j.workCenterId) : null,
        setupMin: j.actualSetupMin,
        runMin: j.actualRunMin,
        qtyGood: j.qtyGood,
        qtyScrap: j.qtyScrap,
        finishedAt: day(j.actualEnd),
        plannedSetupMin: j.plannedSetupMin,
      }))
    ),
    "facts.csv": plainCsv(
      [
        "fact",
        "about",
        "attribute",
        "value",
        "previous_value",
        "status",
        "source",
        "evidence",
        "stated_on",
        "reviewed_on",
        "valid_to",
      ],
      facts.map((f) => ({
        fact: `F-${f.number}`,
        about: f.subjectLabel,
        attribute: f.attribute,
        value: typeof f.value === "string" ? f.value : JSON.stringify(f.value),
        previous_value:
          f.previousValue === null ? null : JSON.stringify(f.previousValue),
        status: f.status,
        source: f.source,
        evidence: f.evidence,
        stated_on: day(f.createdAt),
        reviewed_on: day(f.reviewedAt),
        valid_to: day(f.validTo),
      }))
    ),
    "notes.csv": plainCsv(
      ["created_on", "kind", "text"],
      notes.map((n) => ({
        created_on: day(n.createdAt),
        kind: n.kind,
        text: n.text,
      }))
    ),
    "rfqs.csv": plainCsv(
      [
        "rfq",
        "received_on",
        "customer",
        "subject",
        "status",
        "parts",
        "quotes",
      ],
      rfqs.map((r) => ({
        rfq: `RFQ-${String(r.number).padStart(4, "0")}`,
        received_on: day(r.receivedAt),
        customer: r.customerName,
        subject: r.subject,
        status: r.status,
        parts: r.lines
          .map((l) => `${l.partNo ?? "?"} × ${l.qtys.join("/")}`)
          .join("; "),
        quotes: r.quotes.map((q) => q.quoteNo).join(" "),
      }))
    ),
  });
};
