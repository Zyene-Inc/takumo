import "server-only";

import { database } from "@repo/database";
import type { DocumentFact, FactTally, IngestEvent } from "../knowledge/steps";
import type { Understanding } from "../knowledge/understand";
import { type AiMode, documentAiMode } from "./ai-mode";
import { type Lease, renewLease } from "./lease";

// What every processing stage (stages.ts) shares: the run, its checkpoint,
// the document's pages, and whether it may use AI services right now.

/** Out of time in this run: save and let another run continue. */
export class HandOff extends Error {}

export interface Checkpoint {
  facts?: DocumentFact[];
  factsDone?: number;
  factsError?: boolean;
  recognized?: number;
  tally?: FactTally;
  understanding?: Understanding;
  /** Scanned pages or photos left unread: AI processing was off. */
  unread?: number;
}

export const modeOf = (lease: Lease): Promise<AiMode> =>
  documentAiMode(lease.version.orgId, lease.version.sourceId);

/**
 * Whether this run may send the document to an outside AI service now: its
 * setting is "full". A document someone put in the Trash isn't processed at
 * all: the run hands off, and claims skip it until it's restored (security
 * audit L9). One Takumo moved there itself (deletedBy null) because it
 * couldn't be read is still processed when someone retries it.
 */
export const mayUseAi = async (lease: Lease) => {
  const source = await database.source.findFirst({
    where: { id: lease.version.sourceId, orgId: lease.version.orgId },
    select: { deletedAt: true, deletedBy: true },
  });
  if (source?.deletedAt && source.deletedBy !== null) {
    throw new HandOff();
  }
  return (await modeOf(lease)) === "full";
};

export interface RunOptions {
  /** The file, when the run starts right after the upload (saves a download). */
  bytes?: Uint8Array;
  /** Stop and hand off at this time (ms since epoch). */
  deadline?: number;
  emit?: (event: IngestEvent) => void;
}

export interface Run {
  checkTime: () => void;
  emit: (event: IngestEvent) => void;
  lease: Lease;
  options: RunOptions;
}

export const checkpointOf = (lease: Lease) =>
  (lease.version.checkpoint ?? {}) as Checkpoint;

export const sourceName = async (lease: Lease) =>
  (
    await database.source.findUniqueOrThrow({
      where: { id: lease.version.sourceId },
      select: { name: true },
    })
  ).name;

// Pages are saved as they're read; reading again overwrites them.
const SAVE_PAGES_SQL = `
  insert into "DocumentPage" ("orgId", "versionId", position, page, text, recognized)
  select $1, $2, p.position, p.page, p.text, p.recognized
  from unnest($3::int[], $4::int[], $5::text[], $6::boolean[])
    as p(position, page, text, recognized)
  on conflict ("versionId", position) do update
    set page = excluded.page, text = excluded.text, recognized = excluded.recognized`;

export const savePages = async (
  lease: Lease,
  pages: { page: number | null; position: number; text: string }[],
  scanned: Set<number>
) => {
  await renewLease(lease);
  await database.$executeRawUnsafe(
    SAVE_PAGES_SQL,
    lease.version.orgId,
    lease.version.id,
    pages.map((p) => p.position),
    pages.map((p) => p.page),
    // Postgres can't store NUL characters in text.
    pages.map((p) => p.text.replaceAll("\u0000", "")),
    pages.map((p) => p.page !== null && scanned.has(p.page))
  );
};

export const loadPages = (lease: Lease) =>
  database.documentPage.findMany({
    where: { versionId: lease.version.id, orgId: lease.version.orgId },
    orderBy: { position: "asc" },
    select: { page: true, text: true, recognized: true },
  });

export const textOf = (pages: { text: string }[]) =>
  pages
    .map((p) => p.text)
    .join("\n\n")
    .trim();
