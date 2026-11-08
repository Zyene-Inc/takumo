import "server-only";

import { database } from "@repo/database";
import { documentAiMode } from "./ai-mode";
import { audit } from "./audit";

// Who is processing a version. A run claims a version with one atomic update
// and holds a lease: only the holder may save progress, and it renews the
// lease as it goes. If the run stops (timeout, crash, closed browser) the
// lease runs out and the library sweep claims the version again, resuming
// from the last saved stage. Times come from the database's clock.

export const LEASE_MS = 5 * 60_000;
/** Tries before a version stays failed until someone retries it. */
export const MAX_ATTEMPTS = 3;
/** Versions one shop may have processing at once (caps AI calls). */
export const SHOP_LIMIT = 3;
const RETRY_AFTER_MS = [60_000, 5 * 60_000, 30 * 60_000];

export interface ClaimedVersion {
  attempts: number;
  checkpoint: unknown;
  id: string;
  mimeType: string | null;
  name: string;
  number: number;
  orgId: string;
  sourceId: string;
  stage: string;
  storageKey: string | null;
  uploadedBy: string | null;
}

export interface Lease {
  readonly token: string;
  readonly version: ClaimedVersion;
}

/** The lease ran out and someone else may hold the version now. */
export class LeaseLost extends Error {
  constructor() {
    super("Processing lease lost");
    this.name = "LeaseLost";
  }
}

// A crashed run (lease expired while processing) counts as an attempt; a
// handed-off or queued one doesn't. A shop's limit is checked under a lock,
// so two claims can't both take the last place.
const CLAIM_SQL = `
  update "DocumentVersion" v
  set status = 'processing',
      "leaseOwner" = $2,
      "leaseUntil" = now() + make_interval(secs => $3::double precision / 1000),
      attempts = v.attempts + case when v.status = 'processing' then 1 else 0 end,
      "updatedAt" = now()
  where v.id = $1 and v."orgId" = $4
    and (
      (v.status = 'queued' and (v."nextAttemptAt" is null or v."nextAttemptAt" <= now()))
      or (v.status = 'processing' and v."leaseUntil" < now() and v.attempts + 1 < $5)
      or (v.status = 'failed' and v."nextAttemptAt" <= now() and v.attempts < $5)
    )
    -- A document someone put in the Trash isn't processed (security audit
    -- L9): its version waits, and is picked up again once it's restored.
    -- (One Takumo moved there itself, deletedBy null, because it couldn't
    -- be read, can be retried.)
    and not exists (
      select 1 from "Source" s where s.id = v."sourceId" and s."deletedAt" is not null
        and s."deletedBy" is not null
    )
    and (
      select count(*) from "DocumentVersion" o
      where o."orgId" = v."orgId" and o.status = 'processing'
        and o."leaseUntil" > now() and o.id <> v.id
    ) < $6
  returning v.id, v."orgId", v."sourceId", v.number, v.name, v.stage,
            v."storageKey", v."mimeType", v.checkpoint, v."uploadedBy", v.attempts`;

/** Claim a version to process, or null when it's not due, taken, or the shop is busy. */
export const claimVersion = async (
  versionId: string
): Promise<Lease | null> => {
  const found = await database.documentVersion.findUnique({
    where: { id: versionId },
    select: { orgId: true },
  });
  if (!found) {
    return null;
  }
  const token = crypto.randomUUID();
  const claimed = await database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      `library-process:${found.orgId}`
    );
    const [row] = await tx.$queryRawUnsafe<ClaimedVersion[]>(
      CLAIM_SQL,
      versionId,
      token,
      LEASE_MS,
      found.orgId,
      MAX_ATTEMPTS,
      SHOP_LIMIT
    );
    return row ?? null;
  });
  return claimed && { token, version: claimed };
};

const HELD = (lease: Lease) => ({
  id: lease.version.id,
  leaseOwner: lease.token,
  status: "processing",
});

/** Extend the lease; throws LeaseLost when it isn't ours any more. */
export const renewLease = async (lease: Lease) => {
  const updated = await database.$executeRawUnsafe(
    `update "DocumentVersion"
     set "leaseUntil" = now() + make_interval(secs => $3::double precision / 1000)
     where id = $1 and "leaseOwner" = $2 and status = 'processing'`,
    lease.version.id,
    lease.token,
    LEASE_MS
  );
  if (updated === 0) {
    throw new LeaseLost();
  }
};

/** What a checkpoint holds from AI services (cleared when AI is lowered). */
const AI_CHECKPOINT_KEYS = ["understanding", "facts", "factsDone", "tally"];

/**
 * Save that a stage finished (and renew); throws LeaseLost when it isn't
 * ours. Under the document's row lock (as writeIfFull), a checkpoint keeps
 * what AI services returned only while its setting is "full": a run can't
 * write back what lowering just cleared (security audit L10).
 */
export const saveProgress = async (
  lease: Lease,
  data: { checkpoint?: object; pageCount?: number; stage: string }
) => {
  const { count, checkpoint } = await database.$transaction(async (tx) => {
    let saved = data.checkpoint;
    if (saved) {
      await tx.$queryRawUnsafe(
        `select id from "Source" where id = $1 and "orgId" = $2 for share`,
        lease.version.sourceId,
        lease.version.orgId
      );
      const mode = await documentAiMode(
        lease.version.orgId,
        lease.version.sourceId,
        tx
      );
      if (mode !== "full") {
        saved = Object.fromEntries(
          Object.entries(saved).filter(([k]) => !AI_CHECKPOINT_KEYS.includes(k))
        );
      }
    }
    const result = await tx.documentVersion.updateMany({
      where: HELD(lease),
      data: {
        stage: data.stage,
        ...(saved ? { checkpoint: saved } : {}),
        ...(data.pageCount === undefined ? {} : { pageCount: data.pageCount }),
      },
    });
    return { count: result.count, checkpoint: saved };
  });
  if (count === 0) {
    throw new LeaseLost();
  }
  await renewLease(lease);
  lease.version.stage = data.stage;
  if (checkpoint) {
    lease.version.checkpoint = checkpoint;
  }
};

/** Give the version back to be continued by another run straight away. */
export const releaseLease = (lease: Lease) =>
  database.documentVersion.updateMany({
    where: HELD(lease),
    data: {
      status: "queued",
      leaseOwner: null,
      leaseUntil: null,
      // Due now (no time: the database's clock decides, not this server's).
      nextAttemptAt: null,
    },
  });

/** Processing finished; throws LeaseLost when the lease isn't ours any more. */
export const finishVersion = async (
  lease: Lease,
  status: "ready" | "superseded",
  error: string | null = null
) => {
  const { count } = await database.documentVersion.updateMany({
    where: HELD(lease),
    data: {
      status,
      stage: "done",
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt: null,
      error,
    },
  });
  if (count === 0) {
    throw new LeaseLost();
  }
};

/**
 * A stage failed: retried later with a growing wait, until the tries run
 * out. The document's current version (if any) is untouched. `permanent`:
 * trying again can't help (no text, no original kept).
 */
export const failVersion = async (
  lease: Lease,
  message: string,
  { permanent }: { permanent: boolean }
) => {
  const attempts = permanent ? MAX_ATTEMPTS : lease.version.attempts + 1;
  const retry = attempts < MAX_ATTEMPTS;
  const { count } = await database.documentVersion.updateMany({
    where: HELD(lease),
    data: {
      status: "failed",
      attempts,
      error: message,
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt: retry
        ? new Date(Date.now() + RETRY_AFTER_MS[attempts - 1])
        : null,
    },
  });
  if (count === 0) {
    return { retry: false };
  }
  const { orgId, sourceId, id } = lease.version;
  // A first version that fails leaves a document with nothing to show. Once
  // no retry is left it goes to the Trash (file and all, restorable), so its
  // name is free to upload again.
  await database.source.updateMany({
    where: { id: sourceId, orgId, currentVersionId: null },
    data: { status: "failed" },
  });
  if (!retry) {
    const trashed = await database.source.updateMany({
      where: { id: sourceId, orgId, currentVersionId: null, deletedAt: null },
      data: { deletedAt: new Date(), deletedBy: null },
    });
    if (trashed.count > 0) {
      await audit({
        orgId,
        actorId: null,
        action: "trash",
        sourceId,
        versionId: id,
        detail: { reason: "never_readable" },
      });
    }
  }
  await audit({
    orgId,
    actorId: null,
    action: "processing_failed",
    sourceId,
    versionId: id,
    detail: { version: lease.version.number, willRetry: retry },
  });
  return { retry };
};

/**
 * Runs that kept stopping (expired leases with no tries left) are marked
 * failed: in every shop, or only `orgId`'s.
 */
export const failAbandoned = (orgId: string | null = null) =>
  database.$executeRawUnsafe(
    `update "DocumentVersion"
     set status = 'failed', "leaseOwner" = null, "leaseUntil" = null,
         "nextAttemptAt" = null,
         error = 'Reading this file kept stopping before it finished. Try again, or upload it as a smaller PDF.'
     where status = 'processing' and "leaseUntil" < now() and attempts + 1 >= $1
       and ($2::text is null or "orgId" = $2)`,
    MAX_ATTEMPTS,
    orgId
  );

/**
 * Someone retries a failed version: queued again with fresh tries. Returns
 * false when it isn't a failed version of this document in this shop.
 */
export const requeueVersion = async (
  orgId: string,
  sourceId: string,
  versionId: string
) => {
  const { count } = await database.documentVersion.updateMany({
    where: { id: versionId, orgId, sourceId, status: "failed" },
    data: {
      status: "queued",
      attempts: 0,
      error: null,
      nextAttemptAt: null,
    },
  });
  return count > 0;
};
