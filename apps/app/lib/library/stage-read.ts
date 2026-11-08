import "server-only";
import { readDocument } from "../knowledge/read";
import { plural } from "../knowledge/steps";
import { saveProgress } from "./lease";
import { DocumentProblem } from "./problems";
import { HandOff, loadPages, mayUseAi, type Run, savePages } from "./stage-run";
import { objectStore } from "./storage";

const NO_ORIGINAL =
  "The original file wasn't kept, so it can't be read again. Upload it again.";

/** Stage "read": the file's text, page by page, saved as it's read. */
export const read = async ({ lease, emit, options, checkTime }: Run) => {
  const { version } = lease;
  let bytes = options.bytes ?? null;
  if (!bytes) {
    const store = objectStore();
    if (!(store && version.storageKey)) {
      throw new DocumentProblem(NO_ORIGINAL, { permanent: true });
    }
    bytes = await store.get(version.storageKey);
  }
  // Scanned pages an earlier run already read (by page number).
  const known = new Map<number, string>();
  for (const p of await loadPages(lease)) {
    if (p.recognized && p.page !== null) {
      known.set(p.page, p.text);
    }
  }
  const scanned = new Set(known.keys());
  const resumable = Boolean(version.storageKey && objectStore());
  emit({ type: "step", text: `Reading ${version.name}` });
  const mayRecognize = await mayUseAi(lease);
  const result = await readDocument(version.orgId, version.name, bytes, {
    known,
    recognize: mayRecognize,
    onProgress: (done, total) =>
      emit({
        type: "step",
        text: `Recognising text: page ${done} of ${total}`,
      }),
    onRecognized: async (pages) => {
      // AI turned off meanwhile: keep nothing it read, and start again
      // without it.
      if (!(await mayUseAi(lease))) {
        throw new HandOff();
      }
      for (const p of pages) {
        scanned.add(p.page ?? 1);
      }
      await savePages(
        lease,
        pages.map((p) => ({ ...p, position: (p.page ?? 1) - 1 })),
        scanned
      );
      // Hand off mid-read only when the next run can fetch the file again.
      if (resumable) {
        checkTime();
      }
    },
  });
  await savePages(
    lease,
    result.pages.map((p, position) => ({ ...p, position })),
    scanned
  );
  await saveProgress(lease, {
    stage: "understand",
    pageCount: result.pages.length,
    checkpoint: { recognized: result.recognized, unread: result.unread ?? 0 },
  });
  if (result.unread) {
    emit({
      type: "step",
      text: `Left ${plural(result.unread, "scanned page")} unread: AI processing is off for this folder`,
    });
  }
};

/** Stage "understand": what the document is and which records it's about. */
