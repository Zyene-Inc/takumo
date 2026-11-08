import "server-only";

import { database, type Prisma } from "@repo/database";
import { plainSummary } from "../knowledge/chunk";
import type { Understanding } from "../knowledge/understand";

// What may be sent to outside AI services for a document, set per folder
// (Folder.aiMode). The most restrictive setting on the folder's path applies
// (library.folder_ai_modes); documents outside any folder are "full".
//
//   off     nothing: text is read locally (no scanned pages or photos), split
//           and indexed for the library's search only; never reaches Ask
//   search  the same reading; Ask may use its passages found by keywords
//   full    everything: recognising scans, understanding, context sentences,
//           vectors and facts
//
// Every stage that calls an outside service checks the setting just before
// it, and every write of what came back goes through writeIfFull: the
// document's row is locked (FOR SHARE) and the setting read again, so a
// setting lowered meanwhile wins. Lowering locks the same rows (FOR UPDATE)
// and removes what was derived before (invalidateAi), so a run that was
// already going can't bring it back.

export const AI_MODES = ["off", "search", "full"] as const;
export type AiMode = (typeof AI_MODES)[number];

const RANK: Record<AiMode, number> = { off: 0, search: 1, full: 2 };

export const isAiMode = (value: unknown): value is AiMode =>
  typeof value === "string" && (AI_MODES as readonly string[]).includes(value);

/** a is more restrictive than b. */
export const lower = (a: AiMode, b: AiMode) => RANK[a] < RANK[b];

type Raw = Pick<typeof database, "$queryRawUnsafe">;

const DOCUMENT_MODE_SQL = `
  select ai_mode from library.document_ai_modes($1) where source_id = $2`;

/** The AI setting in force for a document now; "off" when it can't be found. */
export const documentAiMode = async (
  orgId: string,
  sourceId: string,
  client: Raw = database
): Promise<AiMode> => {
  const [row] = await client.$queryRawUnsafe<{ ai_mode: string }[]>(
    DOCUMENT_MODE_SQL,
    orgId,
    sourceId
  );
  return isAiMode(row?.ai_mode) ? row.ai_mode : "off";
};

const FOLDER_MODES_SQL = `
  select folder_id, ai_mode from library.folder_ai_modes($1)`;

/** Each folder's AI setting in force (by id). */
export const folderAiModes = async (orgId: string) =>
  new Map(
    (
      await database.$queryRawUnsafe<{ ai_mode: string; folder_id: string }[]>(
        FOLDER_MODES_SQL,
        orgId
      )
    ).map((r) => [r.folder_id, isAiMode(r.ai_mode) ? r.ai_mode : "off"])
  );

const LOCK_FOR_WRITE_SQL = `
  select id from "Source" where id = $1 and "orgId" = $2 for share`;

/**
 * Write what an outside AI service returned for a document, only if its
 * setting is still "full" once its row is locked. False: nothing written.
 */
export const writeIfFull = (
  orgId: string,
  sourceId: string,
  write: (tx: Prisma.TransactionClient) => Promise<unknown>
) =>
  database.$transaction(async (tx) => {
    const [locked] = await tx.$queryRawUnsafe<{ id: string }[]>(
      LOCK_FOR_WRITE_SQL,
      sourceId,
      orgId
    );
    // A fresh statement after the lock sees any change committed meanwhile.
    if (!locked || (await documentAiMode(orgId, sourceId, tx)) !== "full") {
      return false;
    }
    await write(tx);
    return true;
  });

/**
 * What a document is, worked out locally when it may not be sent to an AI
 * service: no type, no links, its first words as the summary.
 */
export const localUnderstanding = (
  name: string,
  text: string
): Understanding => ({
  card: {
    docType: "other",
    title: name,
    revision: null,
    summary: plainSummary(text),
    mentions: [],
  },
  linked: [],
  unmatched: [],
});

/** Shown when nothing could be read because scans can't be sent anywhere. */
export const NO_TEXT_AI_OFF =
  "Text not extracted: this is a scan or photo, and AI processing is off for its folder. It's stored and can be opened, but not searched.";

/** A document's passages without AI: a plain card, then its text as split. */
export const localPassages = (
  name: string,
  chunks: { content: string; heading: string | null; page: number | null }[]
) => [
  {
    content: name,
    page: null,
    meta: {
      kind: "card",
      docType: "other",
      title: name,
      revision: null,
      links: [],
      unmatched: [],
    },
  },
  ...chunks.map((c) => ({
    content: c.content,
    page: c.page,
    meta: { ...(c.heading ? { heading: c.heading } : {}), mentions: [] },
  })),
];

// Everything derived by AI services from these documents' text: vectors and
// context sentences on their passages, the card's type, summary and links.
const CLEAR_PASSAGES_SQL = `
  update "DocChunk"
  set embedding = null, meta = meta - 'context'
  where "orgId" = $1 and "sourceId" = any($2::text[])`;

const CLEAR_CARDS_SQL = `
  update "DocChunk" c
  set content = s.name,
      meta = jsonb_build_object('kind', 'card', 'docType', 'other', 'title', s.name, 'links', '[]'::jsonb)
  from "Source" s
  where c."orgId" = $1 and c."sourceId" = any($2::text[])
    and c."sourceId" = s.id and c.meta ->> 'kind' = 'card'`;

// Facts read from them that nobody has reviewed yet, when they came only
// from these documents. Approved ones stay, hidden by library.fact_access
// unless published.
const DROP_PENDING_FACTS_SQL = `
  delete from "Fact" f
  where f."orgId" = $1 and f.status = 'pending' and f.provenance = 'documents'
    and exists (select 1 from "FactSource" fs where fs."factId" = f.id)
    and not exists (
      select 1 from "FactSource" fs
      where fs."factId" = f.id and fs."sourceId" <> all($2::text[])
    )`;

// What a run saved from AI services to resume with: the understanding (AI
// summary, type and links) and the facts read, on every version of these
// documents (security audit L10). Kept: pages, recognised counts, progress.
const CLEAR_CHECKPOINTS_SQL = `
  update "DocumentVersion"
  set checkpoint = checkpoint - 'understanding' - 'facts' - 'factsDone' - 'tally'
  where "orgId" = $1 and "sourceId" = any($2::text[]) and checkpoint is not null`;

const LOCK_SOURCES_SQL = `
  select id from "Source" where "orgId" = $1 and id = any($2::text[])
  order by id for update`;

/**
 * Remove what AI services derived from these documents, inside the
 * transaction that lowered their setting (or moved them somewhere stricter).
 * Locks their rows first, so a run writing AI results waits and then sees
 * the new setting. Keeps their text and keyword passages.
 */
export const invalidateAi = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  sourceIds: string[]
) => {
  if (sourceIds.length === 0) {
    return;
  }
  await tx.$queryRawUnsafe(LOCK_SOURCES_SQL, orgId, sourceIds);
  await tx.$executeRawUnsafe(CLEAR_PASSAGES_SQL, orgId, sourceIds);
  await tx.$executeRawUnsafe(CLEAR_CARDS_SQL, orgId, sourceIds);
  await tx.$executeRawUnsafe(DROP_PENDING_FACTS_SQL, orgId, sourceIds);
  await tx.$executeRawUnsafe(CLEAR_CHECKPOINTS_SQL, orgId, sourceIds);
  await tx.source.updateMany({
    where: { orgId, id: { in: sourceIds } },
    data: { summary: null },
  });
};

/**
 * After proposing a fact read by an AI service (proposeFact can't run inside
 * writeIfFull): if the document's setting was lowered meanwhile, drop its
 * pending facts again, as lowering does (security audit L1). The row lock
 * waits for a lowering in progress, so whichever commits second removes it.
 * True when the setting is no longer "full".
 */
export const dropIfLowered = (orgId: string, sourceId: string) =>
  database.$transaction(async (tx) => {
    const [locked] = await tx.$queryRawUnsafe<{ id: string }[]>(
      LOCK_FOR_WRITE_SQL,
      sourceId,
      orgId
    );
    if (locked && (await documentAiMode(orgId, sourceId, tx)) === "full") {
      return false;
    }
    await tx.$executeRawUnsafe(DROP_PENDING_FACTS_SQL, orgId, [sourceId]);
    return true;
  });
