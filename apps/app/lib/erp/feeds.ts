import "server-only";

import { database, forOrg } from "@repo/database";
import type { EntityKey } from "@repo/ingest";

// Which kinds of data the shop's ERP already sends (an active report). Where
// it does, Takumo doesn't ask anyone to type that data in: the ERP is where
// it's entered, Takumo reads it.

/** Last import time per entity the ERP feeds (null: none yet). */
export type ErpFeeds = Partial<Record<EntityKey, Date | null>>;

export const erpFeeds = async (orgId: string): Promise<ErpFeeds> => {
  const reports = await forOrg(database, orgId).erpReport.findMany({
    where: { status: "active" },
    select: { entity: true, lastImportAt: true },
  });
  const feeds: ErpFeeds = {};
  for (const r of reports) {
    const key = r.entity as EntityKey;
    const seen = feeds[key];
    if (!seen || (r.lastImportAt && r.lastImportAt > seen)) {
      feeds[key] = r.lastImportAt;
    }
  }
  return feeds;
};

/** Whether any of these entities comes from the ERP. */
export const fedByErp = (feeds: ErpFeeds, ...entities: EntityKey[]) =>
  entities.some((e) => e in feeds);
