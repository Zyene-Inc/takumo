import "server-only";

import { database, forOrg } from "@repo/database";
import { cite, type Source } from "./citations";
import {
  day,
  type Found,
  insensitive,
  num,
  suggestions,
} from "./records-shared";

export const getQuote = async (orgId: string, key: string): Promise<Found> => {
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

export const getMaterial = async (
  orgId: string,
  key: string
): Promise<Found> => {
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
