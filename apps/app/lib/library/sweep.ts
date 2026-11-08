import "server-only";

import { database } from "@repo/database";
import { failAbandoned, MAX_ATTEMPTS, SHOP_LIMIT } from "./lease";
import { retryStorageDeletions } from "./lifecycle";
import { processVersion } from "./process";

// The library sweep (cron, every few minutes): the safety net that makes
// processing recoverable without anything else running. It deletes stored
// files still waiting, removes uploads abandoned before their file was
// stored, marks runs that kept stopping as failed, and resumes every
// version that is due: queued, handed off, retrying, or whose lease ran out
// because its run stopped (browser closed, timeout, crash).

/** An upload whose file never finished storing is given up after this long. */
export const ABANDONED_UPLOAD_MS = 60 * 60_000;
const DUE_LIMIT = 20;
/** Don't start another version with less time than this left. */
const MIN_RUN_MS = 30_000;

/** Versions stuck in "uploading": their rows and any stored bytes go. */
const cleanAbandonedUploads = async (orgId: string | null) => {
  const stale = await database.documentVersion.findMany({
    where: {
      ...(orgId ? { orgId } : {}),
      status: "uploading",
      createdAt: { lt: new Date(Date.now() - ABANDONED_UPLOAD_MS) },
    },
    select: { id: true, orgId: true, sourceId: true, storageKey: true },
    take: 50,
  });
  for (const v of stale) {
    await database.$transaction(async (tx) => {
      const { count } = await tx.documentVersion.deleteMany({
        where: { id: v.id, status: "uploading" },
      });
      if (count === 0) {
        return;
      }
      if (v.storageKey) {
        await tx.storageDeletion.create({
          data: { orgId: v.orgId, keys: [v.storageKey] },
        });
      }
      // A document whose only version was this upload never existed.
      const left = await tx.documentVersion.count({
        where: { sourceId: v.sourceId },
      });
      if (left === 0) {
        await tx.source.deleteMany({
          where: { id: v.sourceId, currentVersionId: null },
        });
      }
    });
  }
  return stale.length;
};

// The oldest due versions, at most a shop's limit from each shop, so one
// shop's big batch can't keep every other shop waiting.
const DUE_SQL = `
  select id from (
    select id, coalesce("nextAttemptAt", "createdAt") as due_at,
           row_number() over (
             partition by "orgId" order by coalesce("nextAttemptAt", "createdAt")
           ) as place
    from "DocumentVersion" v
    where not exists (
        select 1 from "Source" s where s.id = v."sourceId" and s."deletedAt" is not null
        and s."deletedBy" is not null
      )
      and ((status = 'queued' and ("nextAttemptAt" is null or "nextAttemptAt" <= now()))
       or (status = 'processing' and "leaseUntil" < now())
       or (status = 'failed' and "nextAttemptAt" <= now() and attempts < $1))
      and ($4::text[] is null or "orgId" = any($4))
  ) due
  where place <= $3
  order by due_at
  limit $2`;

/**
 * Versions the sweep would process now, oldest first, fairly across shops
 * (every shop, or only `orgIds`).
 */
export const dueVersions = (orgIds: string[] | null = null) =>
  database.$queryRawUnsafe<{ id: string }[]>(
    DUE_SQL,
    MAX_ATTEMPTS,
    DUE_LIMIT,
    SHOP_LIMIT,
    orgIds
  );

/**
 * One pass over every shop (the cron), or over one shop only (`orgId`: for
 * support, and for tests that mustn't touch each other's shops).
 */
export const sweepLibrary = async ({
  budgetMs = 240_000,
  orgId = null,
}: {
  budgetMs?: number;
  orgId?: string | null;
} = {}) => {
  const deadline = Date.now() + budgetMs;
  const files = await retryStorageDeletions(20, orgId);
  const abandoned = await cleanAbandonedUploads(orgId);
  const gaveUp = await failAbandoned(orgId);
  const due = await dueVersions(orgId ? [orgId] : null);
  const results: Record<string, number> = {};
  for (const { id } of due) {
    if (Date.now() > deadline - MIN_RUN_MS) {
      break;
    }
    const run = await processVersion(id, { deadline });
    results[run.result] = (results[run.result] ?? 0) + 1;
  }
  return { files, abandoned, gaveUp, due: due.length, results };
};
