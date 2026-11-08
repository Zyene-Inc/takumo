import "server-only";
import { canEmbed } from "@repo/ai/lib/models";
import { database } from "@repo/database";
import { plainSummary } from "../knowledge/chunk";
import { plural } from "../knowledge/steps";
import { documentAiMode } from "./ai-mode";
import { LeaseLost } from "./lease";
import { DocumentProblem } from "./problems";
import { checkpointOf, loadPages, type Run, textOf } from "./stage-run";

const LOCK_SOURCE_SQL = `
  select s."currentVersionId", cur.number as "currentNumber"
  from "Source" s
  left join "DocumentVersion" cur on cur.id = s."currentVersionId"
  where s.id = $1 and s."orgId" = $2
  for update of s`;

/** Stage "activate": make this version the document's current one, atomically. */
export const activate = async ({ lease, emit }: Run) => {
  const { version } = lease;
  const understood = checkpointOf(lease).understanding?.card.summary ?? null;
  const pageText = textOf(await loadPages(lease));
  const outcome = await database.$transaction(async (tx) => {
    const [source] = await tx.$queryRawUnsafe<
      { currentNumber: number | null; currentVersionId: string | null }[]
    >(LOCK_SOURCE_SQL, version.sourceId, version.orgId);
    if (!source) {
      throw new DocumentProblem("That document isn't stored any more.", {
        permanent: true,
      });
    }
    // The summary AI wrote only while the setting allows it (the row is
    // locked, so this is the setting in force).
    const full =
      (await documentAiMode(version.orgId, version.sourceId, tx)) === "full";
    const summary = full ? understood : plainSummary(pageText);
    const held = await tx.documentVersion.updateMany({
      where: { id: version.id, leaseOwner: lease.token, status: "processing" },
      data: { activatedAt: new Date(), stage: "facts" },
    });
    if (held.count === 0) {
      throw new LeaseLost();
    }
    if (
      source.currentNumber !== null &&
      source.currentNumber > version.number
    ) {
      // A newer version went live first: this one stays as history,
      // finished here so a stop right after can't leave it half-done.
      await tx.documentVersion.update({
        where: { id: version.id },
        data: {
          activatedAt: null,
          stage: "done",
          status: "superseded",
          leaseOwner: null,
          leaseUntil: null,
          nextAttemptAt: null,
        },
      });
      await tx.docChunk.deleteMany({ where: { versionId: version.id } });
      return "superseded" as const;
    }
    await tx.source.update({
      where: { id: version.sourceId },
      data: { currentVersionId: version.id, status: "ready", summary },
    });
    // Other versions' passages are never searched again.
    await tx.docChunk.deleteMany({
      where: {
        sourceId: version.sourceId,
        orgId: version.orgId,
        OR: [{ versionId: null }, { NOT: { versionId: version.id } }],
      },
    });
    return "active" as const;
  });
  if (outcome === "superseded") {
    return outcome;
  }
  lease.version.stage = "facts";
  const passages = await database.docChunk.count({
    where: { versionId: version.id, NOT: { ordinal: 0 } },
  });
  emit({
    type: "step",
    text: `Indexed ${plural(passages, "passage")} for search${
      canEmbed ? " by meaning and keywords" : " by keywords"
    }`,
  });
  return outcome;
};

/**
 * Read the facts the document states, once, into the checkpoint. Lowered
 * while reading (security audit M2): nothing read is kept. A failure is
 * recorded, not thrown; a hand-off (Trash) passes through.
 */
