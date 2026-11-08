import "server-only";

import { checkDocumentFile } from "../library/files";
import { scheduleHandOff } from "../library/handoff";
import {
  DocumentProblem,
  processVersion,
  type RunOptions,
} from "../library/process";
import {
  createDocument,
  createRereadVersion,
  createVersion,
  type NewVersion,
} from "../library/versions";
import type { IngestEvent } from "./steps";

export type { IngestEvent } from "./steps";

// Reading a document as it's uploaded (the Knowledge page, email, a new
// version, reading again). Each upload is a document version, processed in
// saved stages (lib/library): this request runs as many as it has time for,
// streaming each step, and hands the rest to a background run. If this
// request stops, the library sweep (cron) resumes the version from its last
// saved stage, so closing the browser loses nothing.

/** Time this request spends before handing off (routes allow 300 s). */
export const INLINE_BUDGET_MS = 240_000;

const BACKGROUND = "It will appear in your documents when it's ready.";

/** Process a just-created version in this request, as far as time allows. */
const runNow = async (
  made: NewVersion,
  bytes: Uint8Array | undefined,
  emit: (event: IngestEvent) => void
) => {
  const options: RunOptions = {
    bytes,
    emit,
    deadline: Date.now() + INLINE_BUDGET_MS,
  };
  const run = await processVersion(made.versionId, options);
  if (run.result === "failed") {
    throw new DocumentProblem(
      run.retry
        ? `${run.error} Takumo will try again in a few minutes.`
        : run.error,
      { permanent: !run.retry }
    );
  }
  if (run.result === "handoff") {
    scheduleHandOff(made.versionId);
  }
  if (run.result === "busy" || run.result === "lost") {
    // Another run has it, or the shop has several documents being read:
    // the sweep picks it up.
    emit({ type: "step", text: `Waiting for other documents. ${BACKGROUND}` });
    emit({
      type: "done",
      name: made.name,
      passages: 0,
      linked: 0,
      facts: [],
      background: true,
    });
  }
  return {
    sourceId: made.sourceId,
    versionId: made.versionId,
    name: made.name,
    facts: run.result === "done" ? run.facts : [],
  };
};

const checked = (file: { name: string; bytes: Uint8Array }) => {
  const check = checkDocumentFile(file.name, file.bytes);
  if (!check.ok) {
    throw new DocumentProblem(check.error, { permanent: true });
  }
  return { ...file, mimeType: check.mimeType };
};

/**
 * A new document from an upload or an email: read it, understand it, link it
 * to the shop's records, index it and propose its facts, reporting each step.
 * A live document with the same name is never replaced: DocumentExistsError.
 * `userId` is the uploader, from the server's session or a verified sender.
 */
export const ingestDocument = async (
  orgId: string,
  userId: string | null,
  file: { name: string; bytes: Uint8Array },
  emit: (event: IngestEvent) => void,
  {
    via,
    folderId = null,
    hidden = false,
  }: {
    via: "upload" | "email";
    /** Checked by the caller; null: outside any folder. */
    folderId?: string | null;
    /** The uploader can't see the folder's documents (createDocument). */
    hidden?: boolean;
  }
) => {
  const made = await createDocument(
    orgId,
    userId,
    checked(file),
    via,
    folderId,
    { hidden }
  );
  return runNow(made, file.bytes, emit);
};

/**
 * A new version of a document, uploaded on purpose by someone the caller has
 * checked may edit it. The current version stays in use until this one is
 * ready. Null when the document isn't a live document of this shop.
 */
export const ingestVersion = async (
  orgId: string,
  userId: string,
  sourceId: string,
  file: { name: string; bytes: Uint8Array },
  emit: (event: IngestEvent) => void
) => {
  const made = await createVersion(orgId, userId, sourceId, checked(file));
  return made && runNow(made, file.bytes, emit);
};

/**
 * Read again a document that's already stored (from its saved text): for
 * documents indexed before Takumo understood them. A new version; the
 * current one stays in use until it's ready.
 */
export const rereadDocument = async (
  orgId: string,
  userId: string | null,
  sourceId: string,
  emit: (event: IngestEvent) => void
) => {
  const made = await createRereadVersion(orgId, userId, sourceId);
  if (!made) {
    throw new Error("No text found: that document isn't stored any more.");
  }
  emit({ type: "step", text: `Reading ${made.name} again` });
  return runNow(made, undefined, emit);
};
