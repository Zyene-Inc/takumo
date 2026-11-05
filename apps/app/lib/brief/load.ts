import "server-only";

import { database, forOrg } from "@repo/database";
import { PROVIDER_NAME, type Provider } from "@/lib/connectors/config";
import { healthLines, lateReports } from "@/lib/erp/health";
import { attributeDef, factLabel, formatValue } from "@/lib/facts/attributes";
import { rfqLabel } from "@/lib/quotes/types";
import { latestPlan, orderMaterial } from "@/lib/schedule/plan";
import type { SectionKey, ShopBrief } from "./content";
import { bottleneckOn, lateOrders, materialShortThisWeek } from "./plan-view";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A draft waiting this long is "not sent" (F4.1-R2). */
const DRAFT_WAIT_MS = 24 * HOUR_MS;
/** An RFQ this old without a draft is waiting. */
const NO_DRAFT_MS = 2 * DAY_MS;
/** A quote sent this long ago with no answer gets won / lost buttons. */
const UNANSWERED_MS = 7 * DAY_MS;
/** A mailbox failing this long counts as broken (as the ERP health cron). */
const FAILING_FOR_MS = 26 * HOUR_MS;
const LIST = 20;

const plan = async (orgId: string, today: string) => {
  const saved = await latestPlan(orgId);
  if (!saved) {
    return {
      late: [],
      atRisk: [],
      bottleneck: null,
      material: [],
      planDay: null,
    };
  }
  const p = { request: saved.input.request, output: saved.output };
  const orderNos = saved.output.orders.map((o) => o.order_no);
  const [customers, material] = await Promise.all([
    forOrg(database, orgId).order.findMany({
      where: { orderNo: { in: orderNos } },
      select: { orderNo: true, customer: { select: { name: true } } },
    }),
    orderMaterial(orgId, today),
  ]);
  const { late, atRisk } = lateOrders(
    p,
    new Map(customers.map((c) => [c.orderNo, c.customer?.name ?? null]))
  );
  return {
    late,
    atRisk,
    bottleneck: bottleneckOn(saved.output, today),
    material: materialShortThisWeek(saved.output, material, today),
    planDay: saved.createdAt.toISOString().slice(0, 10),
  };
};

const quotes = async (orgId: string, now: Date) => {
  const db = forOrg(database, orgId);
  const [drafts, noDraft, unanswered] = await Promise.all([
    db.rfq.findMany({
      where: {
        status: "drafted",
        sentAt: null,
        duplicateOfId: null,
        draftedAt: { lt: new Date(now.getTime() - DRAFT_WAIT_MS) },
      },
      orderBy: { draftedAt: "asc" },
      take: LIST,
      select: {
        id: true,
        number: true,
        customerName: true,
        customer: { select: { name: true } },
        draftedAt: true,
      },
    }),
    db.rfq.findMany({
      where: {
        status: "review",
        draftedAt: null,
        duplicateOfId: null,
        receivedAt: { lt: new Date(now.getTime() - NO_DRAFT_MS) },
      },
      orderBy: { receivedAt: "asc" },
      take: LIST,
      select: {
        id: true,
        number: true,
        customerName: true,
        customer: { select: { name: true } },
        receivedAt: true,
      },
    }),
    db.rfqLine.findMany({
      where: {
        quote: { status: "open" },
        rfq: { sentAt: { lt: new Date(now.getTime() - UNANSWERED_MS) } },
      },
      orderBy: { rfq: { sentAt: "asc" } },
      take: LIST,
      select: {
        id: true,
        rfqId: true,
        quote: { select: { quoteNo: true } },
        rfq: {
          select: {
            sentAt: true,
            customerName: true,
            customer: { select: { name: true } },
          },
        },
      },
    }),
  ]);
  return {
    drafts: drafts.map((r) => ({
      rfqId: r.id,
      label: rfqLabel(r.number),
      customer: r.customer?.name ?? r.customerName,
      hours: Math.floor(
        (now.getTime() - (r.draftedAt?.getTime() ?? now.getTime())) / HOUR_MS
      ),
    })),
    noDraft: noDraft.map((r) => ({
      rfqId: r.id,
      label: rfqLabel(r.number),
      customer: r.customer?.name ?? r.customerName,
      days: Math.floor((now.getTime() - r.receivedAt.getTime()) / DAY_MS),
    })),
    unanswered: unanswered.map((l) => ({
      rfqId: l.rfqId,
      lineId: l.id,
      quoteNo: l.quote?.quoteNo ?? "Quote",
      customer: l.rfq.customer?.name ?? l.rfq.customerName,
      days: Math.floor(
        (now.getTime() - (l.rfq.sentAt?.getTime() ?? now.getTime())) / DAY_MS
      ),
    })),
  };
};

/** A pending fact in one line: "F-12: HAAS-VF2 setup time 30 min → 45 min". */
export const factText = (f: {
  attribute: string;
  number: number;
  previousValue: unknown;
  subjectLabel: string;
  subjectType: string;
  value: unknown;
}) => {
  const def = attributeDef(f.subjectType, f.attribute);
  if (f.attribute === "note") {
    return `${factLabel(f.number)}: ${f.subjectLabel}: "${String(f.value)}"`;
  }
  const was =
    f.previousValue === null || f.previousValue === undefined
      ? ""
      : `${formatValue(def ?? null, f.previousValue)} → `;
  return `${factLabel(f.number)}: ${f.subjectLabel} ${(def?.label ?? f.attribute).toLowerCase()} ${was}${formatValue(def ?? null, f.value)}`;
};

const facts = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const [count, top] = await Promise.all([
    db.fact.count({ where: { status: "pending" } }),
    db.fact.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: 3,
      select: {
        id: true,
        number: true,
        subjectType: true,
        subjectLabel: true,
        attribute: true,
        value: true,
        previousValue: true,
      },
    }),
  ]);
  return { count, top: top.map((f) => ({ id: f.id, text: factText(f) })) };
};

const sync = async (orgId: string, now: Date) => {
  const db = forOrg(database, orgId);
  const [reports, broken] = await Promise.all([
    db.erpReport.findMany({
      where: { status: "active" },
      select: {
        name: true,
        status: true,
        lastReceivedAt: true,
        lastImportAt: true,
        updatedAt: true,
      },
    }),
    db.connection.findMany({
      where: {
        OR: [
          { status: "error" },
          {
            status: "connected",
            lastError: { not: null },
            OR: [
              { lastSyncAt: null },
              { lastSyncAt: { lt: new Date(now.getTime() - FAILING_FOR_MS) } },
            ],
          },
        ],
      },
      select: { provider: true, accountLabel: true, account: true },
    }),
  ]);
  return healthLines(
    lateReports(reports, now),
    broken.map(
      (c) =>
        `${PROVIDER_NAME[c.provider as Provider] ?? c.provider} (${c.accountLabel ?? c.account})`
    ),
    now
  );
};

/**
 * What a shop's briefs are made from today. `needed`: the sections anyone
 * due now gets, so nothing else is loaded.
 */
export const loadShopBrief = async (
  orgId: string,
  today: string,
  now: Date,
  needed: ReadonlySet<SectionKey>
): Promise<ShopBrief> => {
  const wants = (...keys: SectionKey[]) => keys.some((k) => needed.has(k));
  const [p, q, f, s] = await Promise.all([
    wants("late", "bottleneck", "material") ? plan(orgId, today) : null,
    wants("quotes") ? quotes(orgId, now) : null,
    wants("facts") ? facts(orgId) : null,
    wants("sync") ? sync(orgId, now) : null,
  ]);
  return {
    late: p?.late ?? [],
    atRisk: p?.atRisk ?? [],
    bottleneck: p?.bottleneck ?? null,
    material: p?.material ?? [],
    planDay: p?.planDay ?? null,
    drafts: q?.drafts ?? [],
    noDraft: q?.noDraft ?? [],
    unanswered: q?.unanswered ?? [],
    facts: f ?? { count: 0, top: [] },
    sync: s ?? [],
  };
};
