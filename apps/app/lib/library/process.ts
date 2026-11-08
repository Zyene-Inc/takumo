import "server-only";

import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { audit } from "./audit";
import {
  claimVersion,
  failVersion,
  type Lease,
  LeaseLost,
  releaseLease,
  renewLease,
} from "./lease";
import { DocumentProblem } from "./problems";
import {
  activate,
  chunk,
  embed,
  facts,
  HandOff,
  type Run,
  type RunOptions,
  read,
  understand,
} from "./stages";
import { StorageError } from "./storage";

export { DocumentProblem } from "./problems";
export type { RunOptions } from "./stages";

// Runs a document version through its stages (stages.ts) under a lease
// (lease.ts): claims it, resumes at the saved stage, hands off when out of
// time, and on failure records a message for people and schedules a retry.

export type RunResult =
  | { result: "done"; facts: string[] }
  | { result: "superseded" }
  | { result: "handoff" }
  | { result: "busy" }
  | { result: "lost" }
  | { result: "failed"; error: string; retry: boolean };

const STAGES = {
  read,
  understand,
  chunk,
  embed,
} as const;

/** The message kept with a failed version: ours, or a plain one (never a provider's). */
const failureMessage = (error: unknown) => {
  if (error instanceof DocumentProblem) {
    return error.message;
  }
  if (error instanceof StorageError) {
    return "Couldn't fetch the original file. Takumo will try again.";
  }
  return "Couldn't read that file just now.";
};

const runStages = async (run: Run) => {
  const { lease, emit } = run;
  while (lease.version.stage in STAGES) {
    run.checkTime();
    await STAGES[lease.version.stage as keyof typeof STAGES](run);
  }
  if (lease.version.stage === "activate") {
    run.checkTime();
    if ((await activate(run)) === "superseded") {
      emit({
        type: "step",
        text: "A newer version is already in use; this one is kept as history",
      });
      emit({
        type: "done",
        name: lease.version.name,
        passages: 0,
        linked: 0,
        facts: [],
      });
      return { result: "superseded" } as const;
    }
  }
  const done = await facts(run);
  const passages = await database.docChunk.count({
    where: { versionId: lease.version.id, NOT: { ordinal: 0 } },
  });
  emit({
    type: "done",
    name: done.name,
    passages,
    linked: done.linked,
    facts: done.tally.proposed,
  });
  await audit({
    orgId: lease.version.orgId,
    actorId: null,
    action: "processed",
    sourceId: lease.version.sourceId,
    versionId: lease.version.id,
    detail: { version: lease.version.number, passages },
  });
  return { result: "done", facts: done.tally.proposed } as const;
};

/** How often a run renews its lease while it works (the lease lasts 5 min). */
export const HEARTBEAT_MS = 60_000;

/**
 * Renew the lease on a timer, so a single long step (an AI call, many
 * context batches) can't outlast it and let a second run start alongside.
 * When the lease turns out to be someone else's, `lost` is set and the run
 * stops at its next check.
 */
const keepLeaseAlive = (lease: Lease) => {
  let lost = false;
  const timer = setInterval(() => {
    renewLease(lease).catch((error: unknown) => {
      if (error instanceof LeaseLost) {
        lost = true;
      }
      // Anything else (a database blip): the next beat tries again.
    });
  }, HEARTBEAT_MS);
  timer.unref?.();
  return { lost: () => lost, stop: () => clearInterval(timer) };
};

/**
 * Process a version as far as this run can. Claims it first (another run
 * may hold it: "busy"); saves after every stage; hands off when the
 * deadline nears; on failure records a message for people and schedules a
 * retry (the document's current version stays as it was).
 */
export const processVersion = async (
  versionId: string,
  options: RunOptions = {}
): Promise<RunResult> => {
  const lease = await claimVersion(versionId);
  if (!lease) {
    return { result: "busy" };
  }
  const emit = options.emit ?? (() => undefined);
  const heartbeat = keepLeaseAlive(lease);
  const run: Run = {
    lease,
    emit,
    options,
    checkTime: () => {
      if (heartbeat.lost()) {
        throw new LeaseLost();
      }
      if (options.deadline && Date.now() > options.deadline) {
        throw new HandOff();
      }
    },
  };
  try {
    return await runStages(run);
  } catch (error) {
    if (error instanceof HandOff) {
      await releaseLease(lease);
      emit({
        type: "step",
        text: "Continuing in the background; it will appear when it's ready",
      });
      emit({
        type: "done",
        name: lease.version.name,
        passages: 0,
        linked: 0,
        facts: [],
        background: true,
      });
      return { result: "handoff" };
    }
    if (error instanceof LeaseLost) {
      return { result: "lost" };
    }
    log.warn("Processing a document version failed", {
      orgId: lease.version.orgId,
      versionId,
      stage: lease.version.stage,
      error: String(error),
    });
    const message = failureMessage(error);
    const { retry } = await failVersion(lease, message, {
      permanent: error instanceof DocumentProblem && error.permanent,
    });
    return { result: "failed", error: message, retry };
  } finally {
    heartbeat.stop();
  }
};
