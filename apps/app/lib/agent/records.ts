import "server-only";

import { database, forOrg } from "@repo/database";
import { attributeDef, factLabel, formatValue } from "@/lib/facts/attributes";
import { factsAbout } from "@/lib/facts/facts";
import type { Viewer } from "@/lib/library/viewer";
import { cite } from "./citations";
import { getMaterial, getQuote } from "./records-quote";
import { day, type Found, type RecordType } from "./records-shared";
import { getCustomer, getMachine, getOrder, getPart } from "./records-shop";

export { RECORD_TYPES } from "./records-shared";

/**
 * Approved knowledge and pending corrections about a part, machine,
 * customer or material: only the facts the viewer may see.
 */
const knowledgeFor = async (viewer: Viewer, type: RecordType, key: string) => {
  const db = forOrg(database, viewer.orgId);
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
          factsAbout(viewer, t, ids).then((f) =>
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

/** A record plus what the shop's people know about it (facts the viewer may see). */
export const getRecordWithKnowledge = async (
  viewer: Viewer,
  type: RecordType,
  key: string
): Promise<Found> => {
  const found = await getRecord(viewer.orgId, type, key);
  if ("error" in found) {
    return found;
  }
  const knowledge = await knowledgeFor(viewer, type, key);
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
