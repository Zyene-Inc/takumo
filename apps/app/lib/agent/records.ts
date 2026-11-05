import "server-only";

import { database, forOrg } from "@repo/database";
import { attributeDef, factLabel, formatValue } from "@/lib/facts/attributes";
import { factsAbout } from "@/lib/facts/facts";
import { latestPlan } from "@/lib/schedule/plan";
import { cite, type Source } from "./citations";

export const RECORD_TYPES = [
  "part",
  "order",
  "machine",
  "customer",
  "quote",
  "material",
] as const;
type RecordType = (typeof RECORD_TYPES)[number];

const num = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const insensitive = (value: string) => ({
  equals: value.trim(),
  mode: "insensitive" as const,
});

type Found = { record: unknown; sources: Source[] } | { error: string };

const suggestions = async (orgId: string, type: RecordType, key: string) => {
  const db = forOrg(database, orgId);
  const contains = {
    contains: key.trim().slice(0, 40),
    mode: "insensitive" as const,
  };
  const names = await (async () => {
    switch (type) {
      case "part":
        return (
          await db.part.findMany({
            where: { partNo: contains },
            take: 5,
            select: { partNo: true },
          })
        ).map((r) => r.partNo);
      case "order":
        return (
          await db.order.findMany({
            where: { orderNo: contains },
            take: 5,
            select: { orderNo: true },
          })
        ).map((r) => r.orderNo);
      case "machine":
        return (
          await db.workCenter.findMany({
            where: { name: contains },
            take: 5,
            select: { name: true },
          })
        ).map((r) => r.name);
      case "customer":
        return (
          await db.customer.findMany({
            where: { name: contains },
            take: 5,
            select: { name: true },
          })
        ).map((r) => r.name);
      case "quote":
        return (
          await db.quote.findMany({
            where: { quoteNo: contains },
            take: 5,
            select: { quoteNo: true },
          })
        ).map((r) => r.quoteNo);
      default:
        return (
          await db.material.findMany({
            where: { name: contains },
            take: 5,
            select: { name: true },
          })
        ).map((r) => r.name);
    }
  })();
  return names.length
    ? `No ${type} "${key}". Did you mean: ${names.join(", ")}?`
    : `No ${type} "${key}" in this shop.`;
};

const planInfo = async (orgId: string) => {
  const plan = await latestPlan(orgId);
  return plan
    ? {
        plan,
        orders: new Map(plan.output.orders.map((o) => [o.order_no, o])),
      }
    : null;
};

const getPart = async (orgId: string, key: string): Promise<Found> => {
  const db = forOrg(database, orgId);
  const parts = await db.part.findMany({
    where: { partNo: insensitive(key) },
    orderBy: { rev: "asc" },
    include: {
      customer: { select: { name: true } },
      material: true,
      routings: { orderBy: { seq: "asc" }, include: { workCenter: true } },
      orders: {
        orderBy: { dueDate: "asc" },
        include: { customer: { select: { name: true } } },
      },
      quotes: {
        orderBy: { quotedAt: "desc" },
        take: 10,
        include: { customer: { select: { name: true } } },
      },
    },
  });
  if (parts.length === 0) {
    return { error: await suggestions(orgId, "part", key) };
  }
  const machines = new Map(
    (await db.workCenter.findMany({ select: { id: true, name: true } })).map(
      (w) => [w.id, w.name]
    )
  );
  const sources: Source[] = [];
  const record = parts.map((p) => {
    sources.push(cite.part(p.partNo, p.id));
    if (p.customer) {
      sources.push(cite.customer(p.customer.name));
    }
    if (p.material) {
      sources.push(cite.material(p.material.name));
    }
    return {
      part_no: p.partNo,
      rev: p.rev,
      description: p.description,
      customer: p.customer?.name ?? null,
      material: p.material
        ? {
            name: p.material.name,
            unit_cost: num(p.material.unitCost),
            unit: p.material.unit,
            lead_time_days: p.material.leadTimeDays,
          }
        : null,
      routing: p.routings.map((r) => {
        sources.push(
          cite.routing(p.partNo, r.seq, p.id),
          cite.machine(r.workCenter.name)
        );
        return {
          seq: r.seq,
          machine: r.workCenter.name,
          setup_min: r.setupMin,
          run_min_per_unit: r.runMinPerUnit,
          alternates: r.altWorkCenterIds
            .map((id) => machines.get(id))
            .filter(Boolean),
          provenance: r.provenance,
        };
      }),
      orders: p.orders.map((o) => {
        sources.push(cite.order(o.orderNo));
        return {
          order_no: o.orderNo,
          customer: o.customer?.name ?? null,
          qty: o.qty,
          due_date: day(o.dueDate),
          price: num(o.price),
          status: o.status,
        };
      }),
      recent_quotes: p.quotes.map((q) => {
        sources.push(cite.quote(q.quoteNo));
        return {
          quote_no: q.quoteNo,
          customer: q.customer?.name ?? null,
          qty: q.qty,
          price: num(q.price),
          status: q.status,
          quoted_on: day(q.quotedAt),
        };
      }),
    };
  });
  return { record: record.length === 1 ? record[0] : record, sources };
};

const getOrder = async (orgId: string, key: string): Promise<Found> => {
  const db = forOrg(database, orgId);
  const order = await db.order.findFirst({
    where: { orderNo: insensitive(key) },
    include: {
      part: {
        include: {
          routings: { orderBy: { seq: "asc" }, include: { workCenter: true } },
        },
      },
      customer: true,
    },
  });
  if (!order) {
    return { error: await suggestions(orgId, "order", key) };
  }
  const sources: Source[] = [
    cite.order(order.orderNo),
    cite.part(order.part.partNo, order.part.id),
    ...order.part.routings.map((r) =>
      cite.routing(order.part.partNo, r.seq, order.part.id)
    ),
  ];
  const routing = order.part.routings.map((r) => {
    const minutes = Math.round(r.setupMin + r.runMinPerUnit * order.qty);
    return {
      seq: r.seq,
      machine: r.workCenter.name,
      setup_min: r.setupMin,
      run_min_per_unit: r.runMinPerUnit,
      minutes_for_this_order: minutes,
      hours_for_this_order: Math.round(minutes / 6) / 10,
    };
  });
  if (order.customer) {
    sources.push(cite.customer(order.customer.name));
  }
  const plan = await planInfo(orgId);
  const planned = plan?.orders.get(order.orderNo);
  if (planned && plan) {
    sources.push(cite.plan());
  }
  return {
    record: {
      order_no: order.orderNo,
      part_no: order.part.partNo,
      rev: order.part.rev,
      customer: order.customer?.name ?? null,
      qty: order.qty,
      due_date: day(order.dueDate),
      price: num(order.price),
      priority: order.priority,
      status: order.status,
      routing,
      total_machine_hours:
        Math.round(
          routing.reduce((sum, r) => sum + r.minutes_for_this_order, 0) / 6
        ) / 10,
      plan:
        planned && plan
          ? {
              completion_date: planned.completion_date,
              days_late: planned.days_late,
              planned_at: plan.plan.createdAt.toISOString(),
              operations: plan.plan.output.operations
                .filter((op) => op.order_no === order.orderNo)
                .map((op) => ({
                  seq: op.seq,
                  machine: op.work_center,
                  start: op.start_at,
                  end: op.end_at,
                  pinned: op.pinned,
                })),
            }
          : "Not in the current plan (no plan yet, or the order changed since it was made).",
    },
    sources,
  };
};

const getMachine = async (orgId: string, key: string): Promise<Found> => {
  const db = forOrg(database, orgId);
  const wc = await db.workCenter.findFirst({
    where: { name: insensitive(key) },
    include: {
      calendar: {
        where: { date: { gte: new Date(Date.now() - 86_400_000) } },
        orderBy: { date: "asc" },
        take: 30,
      },
      _count: { select: { routings: true } },
    },
  });
  if (!wc) {
    return { error: await suggestions(orgId, "machine", key) };
  }
  const shifts = (wc.shifts ?? {}) as { hoursPerDay?: number };
  const plan = await planInfo(orgId);
  const load =
    plan?.plan.output.load.filter((d) => d.work_center === wc.name) ?? [];
  const sum = (days: number) => {
    const end = new Date(
      Date.parse(
        `${plan?.plan.input.request.start_date ?? "1970-01-01"}T00:00:00Z`
      ) +
        days * 86_400_000
    )
      .toISOString()
      .slice(0, 10);
    const within = load.filter((d) => d.date < end);
    const used = within.reduce((s, d) => s + d.load_minutes, 0);
    const capacity = within.reduce((s, d) => s + d.capacity_minutes, 0);
    return {
      planned_hours: Math.round(used / 6) / 10,
      utilization_pct: capacity ? Math.round((used / capacity) * 100) : 0,
    };
  };
  const sources: Source[] = [cite.machine(wc.name)];
  if (plan) {
    sources.push(cite.plan());
  }
  return {
    record: {
      name: wc.name,
      type: wc.type,
      hourly_rate: num(wc.hourlyRate),
      efficiency: wc.efficiency,
      hours_per_day: shifts.hoursPerDay ?? null,
      routing_operations_using_it: wc._count.routings,
      upcoming_calendar: wc.calendar.map((c) => ({
        date: day(c.date),
        available_hours: c.availableHours,
        reason: c.reason,
      })),
      plan_load: plan
        ? { next_7_days: sum(7), next_14_days: sum(14) }
        : "No plan yet.",
    },
    sources,
  };
};

const getCustomer = async (orgId: string, key: string): Promise<Found> => {
  const db = forOrg(database, orgId);
  const customer = await db.customer.findFirst({
    where: { name: insensitive(key) },
    include: {
      parts: { select: { partNo: true, id: true } },
      orders: {
        orderBy: { dueDate: "asc" },
        select: {
          orderNo: true,
          qty: true,
          dueDate: true,
          price: true,
          status: true,
        },
      },
      quotes: {
        orderBy: { quotedAt: "desc" },
        select: {
          quoteNo: true,
          price: true,
          status: true,
          estCost: true,
          actualCost: true,
        },
      },
    },
  });
  if (!customer) {
    return { error: await suggestions(orgId, "customer", key) };
  }
  const won = customer.quotes.filter((q) => q.status === "won").length;
  const lost = customer.quotes.filter((q) => q.status === "lost").length;
  const sources: Source[] = [
    cite.customer(customer.name),
    ...customer.parts.map((p) => cite.part(p.partNo, p.id)),
    ...customer.orders.map((o) => cite.order(o.orderNo)),
    ...customer.quotes.map((q) => cite.quote(q.quoteNo)),
  ];
  return {
    record: {
      name: customer.name,
      payment_term_days: customer.paymentTermDays,
      parts: customer.parts.map((p) => p.partNo),
      orders: customer.orders.map((o) => ({
        order_no: o.orderNo,
        qty: o.qty,
        due_date: day(o.dueDate),
        price: num(o.price),
        status: o.status,
      })),
      quotes: customer.quotes.map((q) => ({
        quote_no: q.quoteNo,
        price: num(q.price),
        status: q.status,
        est_cost: num(q.estCost),
        actual_cost: num(q.actualCost),
      })),
      quote_win_rate_pct:
        won + lost ? Math.round((won / (won + lost)) * 100) : null,
    },
    sources,
  };
};

const getQuote = async (orgId: string, key: string): Promise<Found> => {
  const db = forOrg(database, orgId);
  const q = await db.quote.findFirst({
    where: { quoteNo: insensitive(key) },
    include: { customer: true, part: true },
  });
  if (!q) {
    return { error: await suggestions(orgId, "quote", key) };
  }
  const sources: Source[] = [cite.quote(q.quoteNo)];
  if (q.customer) {
    sources.push(cite.customer(q.customer.name));
  }
  if (q.part) {
    sources.push(cite.part(q.part.partNo, q.part.id));
  }
  const price = num(q.price);
  const cost = num(q.actualCost) ?? num(q.estCost);
  return {
    record: {
      quote_no: q.quoteNo,
      customer: q.customer?.name ?? null,
      part_no: q.part?.partNo ?? null,
      qty: q.qty,
      price,
      lead_time_days: q.leadTimeDays,
      est_cost: num(q.estCost),
      actual_cost: num(q.actualCost),
      margin_pct:
        price && cost !== null
          ? Math.round(((price - cost) / price) * 1000) / 10
          : null,
      status: q.status,
      quoted_on: day(q.quotedAt),
    },
    sources,
  };
};

const getMaterial = async (orgId: string, key: string): Promise<Found> => {
  const db = forOrg(database, orgId);
  const m = await db.material.findFirst({
    where: { name: insensitive(key) },
    include: { parts: { select: { partNo: true, id: true } } },
  });
  if (!m) {
    return { error: await suggestions(orgId, "material", key) };
  }
  return {
    record: {
      name: m.name,
      spec: m.spec,
      unit_cost: num(m.unitCost),
      unit: m.unit,
      lead_time_days: m.leadTimeDays,
      used_by_parts: m.parts.map((p) => p.partNo),
    },
    sources: [
      cite.material(m.name),
      ...m.parts.map((p) => cite.part(p.partNo, p.id)),
    ],
  };
};

/** Approved knowledge and pending corrections about a part, machine, customer or material. */
const knowledgeFor = async (orgId: string, type: RecordType, key: string) => {
  const db = forOrg(database, orgId);
  const where = { equals: key.trim(), mode: "insensitive" as const };
  let subjects: [Parameters<typeof factsAbout>[1], string[]][] = [];
  if (type === "part") {
    const parts = await db.part.findMany({
      where: { partNo: where },
      select: { id: true, routings: { select: { id: true } } },
    });
    subjects = [
      ["part", parts.map((p) => p.id)],
      ["routing", parts.flatMap((p) => p.routings.map((r) => r.id))],
    ];
  } else if (type === "machine") {
    const wc = await db.workCenter.findMany({
      where: { name: where },
      select: { id: true },
    });
    subjects = [["work_center", wc.map((w) => w.id)]];
  } else if (type === "customer") {
    const c = await db.customer.findMany({
      where: { name: where },
      select: { id: true },
    });
    subjects = [["customer", c.map((x) => x.id)]];
  } else if (type === "material") {
    const m = await db.material.findMany({
      where: { name: where },
      select: { id: true },
    });
    subjects = [["material", m.map((x) => x.id)]];
  }
  const facts = (
    await Promise.all(
      subjects
        .filter(([, ids]) => ids.length)
        .map(([t, ids]) =>
          factsAbout(orgId, t, ids).then((f) =>
            f.map((x) => ({ ...x, subjectType: t }))
          )
        )
    )
  ).flat();
  return facts.map((f) => {
    const def = attributeDef(f.subjectType, f.attribute);
    return {
      fact: factLabel(f.number),
      status:
        f.status === "approved"
          ? "approved"
          : "pending review (not applied yet)",
      about: f.subjectLabel,
      what: def?.label ?? f.attribute,
      value: formatValue(def, f.value),
      ...(f.previousValue === null
        ? {}
        : { was: formatValue(def, f.previousValue) }),
      source: f.source,
      evidence: f.evidence,
      stated_on: day(f.createdAt),
    };
  });
};

/** A record plus what the shop's people know about it (facts). */
export const getRecordWithKnowledge = async (
  orgId: string,
  type: RecordType,
  key: string
): Promise<Found> => {
  const found = await getRecord(orgId, type, key);
  if ("error" in found) {
    return found;
  }
  const knowledge = await knowledgeFor(orgId, type, key);
  if (knowledge.length === 0) {
    return found;
  }
  return {
    record: { ...(found.record as object), knowledge },
    sources: [
      ...found.sources,
      ...knowledge.map((k) => cite.fact(k.fact, `${k.about}: ${k.what}`)),
    ],
  };
};

const getRecord = (
  orgId: string,
  type: RecordType,
  key: string
): Promise<Found> => {
  switch (type) {
    case "part":
      return getPart(orgId, key);
    case "order":
      return getOrder(orgId, key);
    case "machine":
      return getMachine(orgId, key);
    case "customer":
      return getCustomer(orgId, key);
    case "quote":
      return getQuote(orgId, key);
    default:
      return getMaterial(orgId, key);
  }
};
