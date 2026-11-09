import "server-only";

import { database, forOrg } from "@repo/database";
import { latestPlan } from "@/lib/schedule/plan";
import type { Source } from "./citations";

export const RECORD_TYPES = [
  "part",
  "order",
  "machine",
  "customer",
  "quote",
  "material",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export type Found = { record: unknown; sources: Source[] } | { error: string };

export const num = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());
export const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
export const insensitive = (value: string) => ({
  equals: value.trim(),
  mode: "insensitive" as const,
});

export const suggestions = async (
  orgId: string,
  type: RecordType,
  key: string
) => {
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

export const planInfo = async (orgId: string) => {
  const plan = await latestPlan(orgId);
  return plan
    ? {
        plan,
        orders: new Map(plan.output.orders.map((o) => [o.order_no, o])),
      }
    : null;
};
