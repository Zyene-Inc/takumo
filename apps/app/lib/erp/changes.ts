import "server-only";

import { database, forOrg } from "@repo/database";
import {
  attributeDef,
  changesModel,
  factLabel,
  formatValue,
  SUBJECT_LABEL,
  type SubjectType,
} from "../facts/attributes";

// Approved facts change Takumo's numbers at once; when the record came from
// the ERP, the next nightly report would put the old number back. Until
// Takumo can write to the ERP (F5.6), these are the changes to make there.

const DAYS = 60;

export interface ErpChange {
  /** Why it changed, as the person who stated it said. */
  evidence: string | null;
  fact: string;
  /** The field in words: "Setup time". */
  field: string;
  /** "Operation", "Machine", … */
  kind: string;
  label: string;
  /** The new value, formatted. */
  now: string;
  reviewedAt: string;
  /** The ERP's value before, formatted; "—" when unknown. */
  was: string;
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
      const field = def?.label ?? f.attribute;
      const now = formatValue(def, f.value);
      return {
        fact: factLabel(f.number),
        kind: SUBJECT_LABEL[f.subjectType as SubjectType] ?? f.subjectType,
        label: f.subjectLabel,
        field,
        was: formatValue(def, f.previousValue),
        now,
        evidence: f.evidence,
        what: `${field}: ${now}`,
        reviewedAt: (f.reviewedAt ?? f.createdAt).toISOString(),
      };
    });
};
