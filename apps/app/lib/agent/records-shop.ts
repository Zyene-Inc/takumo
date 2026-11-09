import "server-only";

import { database, forOrg } from "@repo/database";
import { cite, type Source } from "./citations";
import {
  day,
  type Found,
  insensitive,
  num,
  planInfo,
  suggestions,
} from "./records-shared";

export const getPart = async (orgId: string, key: string): Promise<Found> => {
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

export const getOrder = async (orgId: string, key: string): Promise<Found> => {
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

export const getMachine = async (
  orgId: string,
  key: string
): Promise<Found> => {
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

export const getCustomer = async (
  orgId: string,
  key: string
): Promise<Found> => {
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
