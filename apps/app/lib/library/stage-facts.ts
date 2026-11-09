import "server-only";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  type FactTally,
  plural,
  proposeOne,
  readDocumentFacts,
  reportFacts,
} from "../knowledge/steps";
import { dropIfLowered } from "./ai-mode";
import { finishVersion, type Lease, renewLease, saveProgress } from "./lease";
import {
  type Checkpoint,
  checkpointOf,
  HandOff,
  loadPages,
  mayUseAi,
  type Run,
  textOf,
} from "./stage-run";

const readFactsOnce = async (
  lease: Lease,
  checkpoint: Checkpoint,
  emit: Run["emit"]
): Promise<Checkpoint> => {
  try {
    const text = textOf(await loadPages(lease));
    const read = await readDocumentFacts(lease.version.orgId, text, () =>
      mayUseAi(lease)
    );
    return read && (await mayUseAi(lease))
      ? { ...checkpoint, facts: read, factsDone: 0 }
      : { ...checkpoint, facts: [], factsDone: 0 };
  } catch (error) {
    if (error instanceof HandOff) {
      throw error;
    }
    log.warn("Reading facts from a document failed", {
      error: String(error),
    });
    emit({ type: "step", text: "Couldn't read facts from it this time" });
    return { ...checkpoint, factsError: true };
  }
};

/**
 * Stage "facts": read the facts the document states and propose them for
 * review, saving after each so none is proposed twice. A failure here
 * doesn't undo the document, as before: it's live, and facts can be read
 * again later.
 */
export const facts = async ({ lease, emit, checkTime }: Run) => {
  const { version } = lease;
  // Only for the current version of a document that isn't in the Trash.
  const current = await database.source.findFirst({
    where: {
      id: version.sourceId,
      currentVersionId: version.id,
      deletedAt: null,
    },
    select: { name: true },
  });
  let checkpoint = checkpointOf(lease);
  const tally: FactTally = checkpoint.tally ?? {
    proposed: [],
    conflicts: 0,
    confirmed: 0,
    skipped: 0,
  };
  // Facts are read by an AI service: only while the setting allows it.
  const full = await mayUseAi(lease);
  // A newer version went live meanwhile: its own facts are what count.
  if (current && full && !checkpoint.facts && !checkpoint.factsError) {
    checkpoint = await readFactsOnce(lease, checkpoint, emit);
    await saveProgress(lease, { stage: "facts", checkpoint });
  }
  const found = current && full ? (checkpoint.facts ?? []) : [];
  for (let i = checkpoint.factsDone ?? 0; i < found.length; i += 1) {
    // A run that lost its lease proposes nothing more, nor one whose
    // folder's AI setting was lowered meanwhile (any fact that slips
    // through stays hidden: library.fact_access needs "full").
    await renewLease(lease);
    if (!(await mayUseAi(lease))) {
      break;
    }
    await proposeOne(
      version.orgId,
      version.uploadedBy,
      {
        name: current?.name ?? version.name,
        sourceId: version.sourceId,
        versionId: version.id,
      },
      found[i],
      tally
    );
    // Lowered while it was being proposed: lowering may have missed it, so
    // it's dropped here (security audit L1).
    if (await dropIfLowered(version.orgId, version.sourceId)) {
      break;
    }
    checkpoint = { ...checkpoint, factsDone: i + 1, tally };
    await saveProgress(lease, { stage: "facts", checkpoint });
    checkTime();
  }
  const linked = full ? (checkpoint.understanding?.linked ?? []) : [];
  const name = current?.name ?? version.name;
  if (full) {
    reportFacts(emit, tally);
    emit({
      type: "step",
      text: linked.length
        ? `Updated Brain: ${name} → ${plural(linked.length, "record")}`
        : "Updated Brain",
    });
  }
  await finishVersion(
    lease,
    "ready",
    checkpoint.factsError ? "Couldn't read facts from it this time." : null
  );
  return { tally, linked: linked.length, name };
};
