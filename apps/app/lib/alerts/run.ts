import "server-only";

import { listShopMembers } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import {
  type OrderResult,
  SOLVED_STATUSES,
  schedule,
} from "@repo/engine-client";
import { log } from "@repo/observability/log";
import { linkMaker } from "@/lib/brief/urls";
import { rfqLabel } from "@/lib/quotes/types";
import { loadShop, orderMaterial } from "@/lib/schedule/plan";
import { isoDay } from "@/lib/schedule/request";
import { type AlertChannel, emailChannel } from "./channels";
import {
  ALERT_TITLE,
  type AlertFinding,
  type AlertType,
  lateByNewOrders,
  machineDown,
  materialLate,
  topCustomerRfqs,
  topCustomers,
} from "./detect";
import { deliveries, FIRST_LOOKBACK_MS } from "./throttle";

// Alerts (docs/PRODUCT-PLAN.md F4.3), every 15 minutes from
// /api/cron/notify: find what changed in each shop, store each finding once,
// then send each person what's new for them, batched, at most one email per
// type an hour.

const DAY_MS = 86_400_000;
const REVENUE_DAYS = 365;
/** Each what-if plan gets this long (two per shop with new orders). */
const WHAT_IF_LIMIT_S = 5;

/** Orders new since the last look that push other orders late. */
const lateFromNewOrders = async (
  orgId: string,
  since: Date,
  today: string
): Promise<AlertFinding[]> => {
  const fresh = await forOrg(database, orgId).order.findMany({
    where: {
      createdAt: { gt: since },
      status: { in: ["open", "in_progress"] },
    },
    select: { orderNo: true },
  });
  if (fresh.length === 0) {
    return [];
  }
  const newNos = fresh.map((o) => o.orderNo);
  const built = await loadShop(orgId, today);
  const withNew = { ...built.request, time_limit_s: WHAT_IF_LIMIT_S };
  if (!withNew.orders.some((o) => newNos.includes(o.order_no))) {
    return [];
  }
  const without = {
    ...withNew,
    orders: withNew.orders.filter((o) => !newNos.includes(o.order_no)),
    pins: (withNew.pins ?? []).filter((p) => !newNos.includes(p.order_no)),
  };
  let a: OrderResult[];
  let b: OrderResult[];
  try {
    const [before, after] = await Promise.all([
      schedule(without),
      schedule(withNew),
    ]);
    if (
      !(
        SOLVED_STATUSES.includes(before.status) &&
        SOLVED_STATUSES.includes(after.status)
      )
    ) {
      return [];
    }
    a = before.orders;
    b = after.orders;
  } catch (error) {
    log.warn("Alerts: what-if plan failed", { orgId, error: String(error) });
    return [];
  }
  return lateByNewOrders(a, b, newNos);
};

/** Everything worth an alert in one shop now. */
const findAll = async (
  orgId: string,
  since: Date,
  first: boolean,
  now: Date
): Promise<AlertFinding[]> => {
  const db = forOrg(database, orgId);
  const today = isoDay(now);
  const [calendar, machines, jobs, rfqs, revenue] = await Promise.all([
    db.calendarDay.findMany({
      where: {
        date: { gte: new Date(`${today}T00:00:00Z`) },
        availableHours: { lte: 0 },
      },
      select: {
        workCenterId: true,
        date: true,
        availableHours: true,
        reason: true,
        workCenter: { select: { name: true } },
      },
    }),
    db.workCenter.count(),
    db.job.findMany({
      where: { actualStart: null, plannedStart: { not: null } },
      select: { plannedStart: true, order: { select: { orderNo: true } } },
    }),
    first
      ? []
      : db.rfq.findMany({
          where: {
            receivedAt: { gt: since },
            duplicateOfId: null,
            customerId: { not: null },
            status: { notIn: ["filtered", "failed"] },
          },
          select: {
            id: true,
            number: true,
            customerId: true,
            customerName: true,
            customer: { select: { name: true } },
          },
        }),
    db.order.findMany({
      where: {
        createdAt: { gte: new Date(now.getTime() - REVENUE_DAYS * DAY_MS) },
        price: { not: null },
      },
      select: { customerId: true, price: true },
    }),
  ]);

  const starts = new Map<string, string>();
  for (const j of jobs) {
    const day = j.plannedStart ? isoDay(j.plannedStart) : null;
    const seen = starts.get(j.order.orderNo);
    if (day && day >= today && (!seen || day < seen)) {
      starts.set(j.order.orderNo, day);
    }
  }
  const material = starts.size ? await orderMaterial(orgId, today) : new Map();

  const findings: AlertFinding[] = [
    ...machineDown(
      calendar.map((c) => ({
        workCenterId: c.workCenterId,
        machine: c.workCenter.name,
        date: isoDay(c.date),
        hours: c.availableHours,
        reason: c.reason,
      })),
      machines,
      today
    ),
    ...materialLate(
      [...starts].map(([orderNo, start]) => ({ orderNo, start })),
      material
    ),
    ...topCustomerRfqs(
      rfqs.map((r) => ({
        id: r.id,
        label: rfqLabel(r.number),
        customerId: r.customerId,
        customer: r.customer?.name ?? r.customerName ?? "a customer",
      })),
      topCustomers(
        revenue.map((o) => ({
          customerId: o.customerId,
          amount: Number(o.price ?? 0),
        }))
      )
    ),
  ];
  if (!first) {
    findings.push(...(await lateFromNewOrders(orgId, since, today)));
  }
  return findings;
};

const subjectFor = (type: AlertType, count: number) =>
  count === 1 ? ALERT_TITLE[type] : `${ALERT_TITLE[type]} (${count})`;

interface AlertRun {
  found: number;
  sent: number;
  shops: number;
}

export const runAlerts = async (
  now: Date,
  channel: AlertChannel = emailChannel
): Promise<AlertRun> => {
  const result: AlertRun = { shops: 0, found: 0, sent: 0 };
  const orgs = await database.org.findMany({
    select: { id: true, alertWatch: { select: { checkedAt: true } } },
  });
  for (const org of orgs) {
    result.shops += 1;
    const first = !org.alertWatch;
    const since = org.alertWatch?.checkedAt ?? now;
    try {
      const findings = await findAll(org.id, since, first, now);
      if (findings.length) {
        const saved = await database.alertEvent.createMany({
          skipDuplicates: true,
          // The first look only records what's already true: no alerts for it.
          data: findings.map((f) => ({
            ...f,
            orgId: org.id,
            quiet: first,
            createdAt: now,
          })),
        });
        result.found += saved.count;
      }
      await database.alertWatch.upsert({
        where: { orgId: org.id },
        create: { orgId: org.id, checkedAt: now },
        update: { checkedAt: now },
      });
    } catch (error) {
      log.error("Alerts: couldn't check a shop", {
        orgId: org.id,
        error: String(error),
      });
      continue;
    }
    if (!channel.ready()) {
      continue;
    }
    result.sent += await deliver(org.id, now, channel);
  }
  return result;
};

/** Send each person in the shop what's new for them. */
const deliver = async (orgId: string, now: Date, channel: AlertChannel) => {
  const events = await database.alertEvent.findMany({
    where: {
      orgId,
      quiet: false,
      createdAt: { gt: new Date(now.getTime() - FIRST_LOOKBACK_MS) },
    },
    orderBy: { createdAt: "asc" },
  });
  if (events.length === 0) {
    return 0;
  }
  const [members, prefs, sentRows] = await Promise.all([
    listShopMembers(orgId),
    database.notifyPrefs.findMany({
      where: { orgId },
      select: { userId: true, alertsOff: true },
    }),
    database.alertSent.findMany({ where: { orgId } }),
  ]);
  const off = new Map(prefs.map((p) => [p.userId, p.alertsOff]));
  const byUser = new Map(members.map((m) => [m.userId, m]));
  const plan = deliveries(
    events,
    members
      .filter((m) => m.email)
      .map((m) => ({
        userId: m.userId,
        role: m.role,
        off: off.get(m.userId) ?? [],
      })),
    new Map(sentRows.map((s) => [`${s.userId}|${s.type}`, s.sentAt])),
    now
  );
  let sent = 0;
  for (const d of plan) {
    const member = byUser.get(d.userId);
    if (!member) {
      continue;
    }
    const links = linkMaker({ orgId, userId: d.userId }, now);
    const ok = await channel.send(
      { userId: d.userId, email: member.email },
      {
        subject: subjectFor(d.type, d.events.length),
        lines: d.events.map((e) => ({
          text: e.message,
          href: links.go(`alert:${d.type}`, e.path),
        })),
        unsubscribe: {
          page: links.unsubscribe(`alert:${d.type}`),
          oneClick: links.oneClick(`alert:${d.type}`),
        },
      }
    );
    if (ok) {
      sent += 1;
      await database.alertSent.upsert({
        where: {
          orgId_userId_type: { orgId, userId: d.userId, type: d.type },
        },
        create: { orgId, userId: d.userId, type: d.type, sentAt: now },
        update: { sentAt: now },
      });
    }
  }
  return sent;
};
