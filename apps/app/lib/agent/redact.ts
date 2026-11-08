import "server-only";

import type { UIMessage } from "@repo/ai";
import { database } from "@repo/database";
import { usableSourceIds } from "../library/ai-access";
import { trustedViewer, type Viewer } from "../library/viewer";

// Saved answers can repeat what a document said: in their text, their tool
// results and their citations. Before a conversation is shown, compacted or
// sent to the model again, every answer that drew on a document the person
// may not use now (restricted, moved out of their reach, in the Trash, AI
// turned off) is replaced by a notice. Which documents an answer drew on is
// MessageSource (lib/library/provenance.ts): its own and every earlier
// answer's in the conversation, since a later answer can repeat an earlier
// one. Answers that can't be traced (saved before this was recorded, or
// only partly attributed) are hidden once the shop restricts any document,
// except from the owner, who may open everything. Access is checked as it
// is now, so an answer comes back if access does.

export const HIDDEN_ANSWER =
  "Hidden: this answer used a document you can't open now. It may have been restricted, moved, or put in the Trash.";

export const HIDDEN_UNTRACED =
  "Hidden: Takumo can't tell which documents this older answer used, and some of this shop's documents are restricted.";

/** Whether the shop restricts who may open documents (its stage). */
export const shopRestricts = async (orgId: string) =>
  (
    await database.org.findUnique({
      where: { id: orgId },
      select: { libraryStage: true },
    })
  )?.libraryStage === "confidential";

/** Why an answer is hidden from this viewer, or null to show it. Pure. */
export const hiddenBecause = ({
  provenance,
  sources,
  usable,
  restricts,
  isOwner,
}: {
  isOwner: boolean;
  /** The saved answer's provenance; undefined when it isn't saved. */
  provenance: string | undefined;
  restricts: boolean;
  sources: string[];
  usable: Set<string>;
}): string | null => {
  if (provenance === "removed") {
    // Already rewritten when its document was deleted for good.
    return null;
  }
  if (sources.some((id) => !usable.has(id))) {
    return HIDDEN_ANSWER;
  }
  const traced = provenance === "recorded";
  return !traced && restricts && !isOwner ? HIDDEN_UNTRACED : null;
};

const notice = <M extends Pick<UIMessage, "parts">>(message: M, text: string) =>
  ({ ...message, parts: [{ type: "text" as const, text }] }) as M;

/**
 * The conversation's messages as this viewer may see them now. The person's
 * own questions are kept; answers are replaced by a notice when hidden.
 */
export const redactHistory = async <
  M extends Pick<UIMessage, "id" | "parts" | "role">,
>(
  viewer: Viewer,
  conversationId: string,
  messages: M[]
): Promise<M[]> => {
  const { orgId, isOwner } = trustedViewer(viewer);
  if (!messages.some((m) => m.role === "assistant")) {
    return messages;
  }
  const [saved, links, usable, restricts] = await Promise.all([
    database.message.findMany({
      where: { conversationId, conversation: { orgId }, role: "assistant" },
      select: { id: true, provenance: true },
    }),
    database.messageSource.findMany({
      where: { orgId, conversationId },
      select: { messageId: true, sourceId: true },
    }),
    usableSourceIds(viewer, "search"),
    shopRestricts(orgId),
  ]);
  const provenance = new Map(saved.map((m) => [m.id, m.provenance]));
  const sources = new Map<string, string[]>();
  for (const link of links) {
    sources.set(link.messageId, [
      ...(sources.get(link.messageId) ?? []),
      link.sourceId,
    ]);
  }
  return messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }
    const why = hiddenBecause({
      provenance: provenance.get(message.id),
      sources: sources.get(message.id) ?? [],
      usable,
      restricts,
      isOwner,
    });
    return why ? notice(message, why) : message;
  });
};

/**
 * Just before an answer is saved: whether everything it drew on is still
 * open to its asker. Access can change while the model is answering; what
 * was already streamed can't be taken back, but nothing newly out of reach
 * is saved or sent again.
 */
/**
 * Which of an answer's documents must still be open to its asker when it's
 * saved: those its own tools and facts used, and earlier answers' documents
 * the asker could use when they asked. An earlier answer whose document was
 * already out of reach was hidden before the question reached the model, so
 * the new answer can't repeat it. The new answer stays linked to that
 * document (MessageSource): hidden while it's out of reach and shown again if
 * access comes back, instead of being saved as a notice for good.
 */
export const documentsToRecheck = (
  rows: { direct: boolean; sourceId: string }[],
  usableWhenAsked: Set<string>
) =>
  rows
    .filter((r) => r.direct || usableWhenAsked.has(r.sourceId))
    .map((r) => r.sourceId);

export const stillAllowed = async (viewer: Viewer, documentIds: string[]) => {
  if (documentIds.length === 0) {
    return true;
  }
  const usable = await usableSourceIds(viewer, "search");
  return documentIds.every((id) => usable.has(id));
};
