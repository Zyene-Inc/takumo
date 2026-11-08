import "server-only";
import { extractedLine, reportUnderstanding } from "../knowledge/steps";
import {
  loadCatalog,
  type Understanding,
  understandDocument,
} from "../knowledge/understand";
import { localUnderstanding, NO_TEXT_AI_OFF } from "./ai-mode";
import { saveProgress } from "./lease";
import { DocumentProblem } from "./problems";
import {
  checkpointOf,
  loadPages,
  mayUseAi,
  type Run,
  sourceName,
  textOf,
} from "./stage-run";

export const understand = async ({ lease, emit }: Run) => {
  const pages = await loadPages(lease);
  const text = textOf(pages);
  if (!text) {
    throw new DocumentProblem(
      checkpointOf(lease).unread
        ? NO_TEXT_AI_OFF
        : "No text found in that file.",
      { permanent: true }
    );
  }
  emit({
    type: "step",
    text: extractedLine(pages.length, checkpointOf(lease).recognized ?? 0),
  });
  const name = await sourceName(lease);
  let understanding: Understanding;
  if (await mayUseAi(lease)) {
    const shop = await loadCatalog(lease.version.orgId);
    understanding = await understandDocument(
      lease.version.orgId,
      name,
      text,
      shop
    );
    // Lowered while the AI service was answering: keep nothing it said
    // (security audit M2).
    if (!(await mayUseAi(lease))) {
      understanding = localUnderstanding(name, text);
    }
    reportUnderstanding(emit, understanding);
  } else {
    understanding = localUnderstanding(name, text);
    emit({
      type: "step",
      text: "AI processing is off for this folder: indexed for keyword search only",
    });
  }
  await saveProgress(lease, {
    stage: "chunk",
    checkpoint: { ...checkpointOf(lease), understanding },
  });
};

/** Stage "chunk": the card and the passages, written once each. */
