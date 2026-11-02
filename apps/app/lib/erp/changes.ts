import "server-only";

import { database, forOrg } from "@repo/database";
import {
  attributeDef,
  changesModel,
  factLabel,
  formatValue,
} from "../facts/attributes";

// Approved facts change Takumo's numbers at once; when the record came from
// the ERP, the next nightly report would put the old number back. Until
// Takumo can write to the ERP (F5.6), these are the changes to make there.

const DAYS = 60;

export interface ErpChange {
  fact: string;
  label: string;
  reviewedAt: string;
  what: string;
}

const syncedIds = async (
  orgId: string,
  type: string,
  ids: string[]
): Promise<Set<string>> => {
  const db = forOrg(database, orgId);
  const where = { id: { in: ids }, syncedAt: { not: null } };
  const select = { id: true } as const;
  let rows: { id: string }[] = [];
  if (type === "routing") {
    rows = await db.routing.findMany({ where, select });
  } else if (type === "work_center") {
    rows = await db.workCenter.findMany({ where, select });
  } else if (type === "part") {
    rows = await db.part.findMany({ where, select });
  } else if (type === "material") {
    rows = await db.material.findMany({ where, select });
  } else if (type === "customer") {
    rows = await db.customer.findMany({ where, select });
  }
  return new Set(rows.map((r) => r.id));
};

export const changesForErp = async (orgId: string): Promise<ErpChange[]> => {
  const facts = await forOrg(database, orgId).fact.findMany({
    where: {
      status: "approved",
      reviewedAt: { gte: new Date(Date.now() - DAYS * 86_400_000) },
    },
    orderBy: { reviewedAt: "desc" },
    take: 200,
  });
  const numbers = facts.filter((f) => changesModel(f.attribute));
  const synced = new Map<string, Set<string>>();
  for (const type of new Set<string>(numbers.map((f) => f.subjectType))) {
    synced.set(
      type,
      await syncedIds(
        orgId,
        type,
        numbers.filter((f) => f.subjectType === type).map((f) => f.subjectId)
      )
    );
  }
  return numbers
    .filter((f) => synced.get(f.subjectType)?.has(f.subjectId))
    .map((f) => {
      const def = attributeDef(f.subjectType, f.attribute);
      return {
        fact: factLabel(f.number),
        label: f.subjectLabel,
        what: `${def?.label ?? f.attribute}: ${formatValue(def, f.value)}`,
        reviewedAt: (f.reviewedAt ?? f.createdAt).toISOString(),
      };
    });
};
