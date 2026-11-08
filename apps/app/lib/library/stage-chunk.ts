import "server-only";
import { database } from "@repo/database";
import { chunkPages } from "../knowledge/chunk";
import { mentionsIn, plural } from "../knowledge/steps";
import { contextualize, DOC_TYPE_LABEL } from "../knowledge/understand";
import { localPassages, localUnderstanding, writeIfFull } from "./ai-mode";
import { renewLease, saveProgress } from "./lease";
import {
  checkpointOf,
  loadPages,
  mayUseAi,
  type Run,
  sourceName,
  textOf,
} from "./stage-run";

export const chunk = async ({ lease, emit }: Run) => {
  const { version } = lease;
  const pages = await loadPages(lease);
  const text = textOf(pages);
  const name = await sourceName(lease);
  const full = await mayUseAi(lease);
  const understood = checkpointOf(lease).understanding;
  // What AI understood is only used while the setting still allows it, and
  // lowering it clears it from the checkpoint (ai-mode.ts).
  const understanding =
    full && understood ? understood : localUnderstanding(name, text);
  const { card, linked, unmatched } = understanding;
  const chunks = chunkPages(pages);
  const tables = chunks.filter((c) => c.content.includes("| --- |")).length;
  emit({
    type: "step",
    text: `Split into ${plural(chunks.length, "passage")}${
      tables ? ` (${plural(tables, "table")} kept whole)` : ""
    }`,
  });
  let contexts: string[] = full
    ? await contextualize(
        version.orgId,
        { name, summary: card.summary, text },
        chunks.map((c) => c.content),
        () => mayUseAi(lease)
      )
    : [];
  // Lowered meanwhile: no context sentence from the AI service is kept
  // (security audit M2).
  if (full && !(await mayUseAi(lease))) {
    contexts = [];
  }
  const withContext = contexts.filter(Boolean).length;
  if (withContext) {
    emit({
      type: "step",
      text: `Added context to ${plural(withContext, "passage")}`,
    });
  }
  // A card for the whole document: found by questions about the document
  // itself, and the Brain's record of what it links to.
  const cardText = [
    `${name}: ${DOC_TYPE_LABEL[card.docType]}${card.revision ? `, rev ${card.revision}` : ""}.`,
    card.summary,
    linked.length ? `About: ${linked.map((m) => m.label).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const rows = [
    {
      content: cardText,
      page: null,
      meta: {
        kind: "card",
        docType: card.docType,
        title: card.title,
        revision: card.revision,
        links: linked.map((m) => ({
          ref: `${m.type}:${m.id}`,
          label: m.label,
          quote: m.quote,
          how: m.how,
        })),
        unmatched,
      },
    },
    ...chunks.map((c, i) => ({
      content: c.content,
      page: c.page,
      meta: {
        ...(c.heading ? { heading: c.heading } : {}),
        ...(contexts[i] ? { context: contexts[i] } : {}),
        mentions: mentionsIn(c.content, linked),
      },
    })),
  ];
  await renewLease(lease);
  const data = (list: typeof rows) =>
    list.map((r, ordinal) => ({
      orgId: version.orgId,
      sourceId: version.sourceId,
      versionId: version.id,
      ordinal,
      content: r.content.replaceAll("\u0000", ""),
      page: r.page,
      meta: r.meta,
    }));
  const wroteAi =
    full &&
    (await writeIfFull(version.orgId, version.sourceId, (tx) =>
      tx.docChunk.createMany({ data: data(rows), skipDuplicates: true })
    ));
  if (!wroteAi) {
    // AI off (or turned off while it ran): a plain card and the passages.
    await database.docChunk.createMany({
      data: data(localPassages(name, chunks) as typeof rows),
      skipDuplicates: true,
    });
  }
  await saveProgress(lease, { stage: "embed" });
};
