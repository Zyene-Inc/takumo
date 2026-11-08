import "server-only";

import { database } from "@repo/database";
import { accessTo, requireCapability } from "./access";
import { type AiMode, isAiMode, lower } from "./ai-mode";
import { audit } from "./audit";
import { modesOf, settleAiAfterMove } from "./moves";
import { confidentialEnabled, NOT_YET } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// Changing what may be sent to outside AI services for a folder's documents
// (and the folders inside it). Needs manage on the folder. Lowering it takes
// effect at once: processing checks it before every outside call, and what
// AI services derived from the documents (vectors, context sentences, cards,
// summaries, unreviewed facts) is removed in the same transaction
// (ai-mode.ts). Raising it doesn't send anything by itself: documents
// already there keep keyword search until they're read again.

export type AiSettingResult =
  | { ok: true }
  | { ok: false; error: string }
  /** Turning AI on for a confidential folder: ask first, then confirm. */
  | { ok: false; error: string; confirm: true };

export const AI_ON_CONFIDENTIAL =
  "This folder is confidential. With AI processing on, its documents (and, for Search, passages from them when someone with access asks) may be sent to outside AI services. Confirm to go ahead.";

export const setFolderAiMode = async (
  viewer: Viewer,
  folderId: string,
  mode: string,
  { confirmed = false }: { confirmed?: boolean } = {}
): Promise<AiSettingResult> => {
  const { orgId, userId, isSystem } = trustedViewer(viewer);
  if (!isAiMode(mode)) {
    return { ok: false, error: "Choose Off, Search or Full." };
  }
  if (isSystem) {
    return { ok: false, error: "Only a person can change this." };
  }
  if (!(await confidentialEnabled(orgId))) {
    return { ok: false, error: NOT_YET };
  }
  const check = await requireCapability(viewer, { folderId }, "manage");
  if (!check.ok) {
    return {
      ok: false,
      error:
        check.reason === "not_found"
          ? "That folder isn't there any more."
          : "Only someone who manages this folder can change its AI setting.",
    };
  }
  const folder = await database.folder.findFirst({
    where: { id: folderId, orgId },
    select: { kind: true, aiMode: true },
  });
  if (!folder || folder.kind.startsWith("virtual")) {
    return { ok: false, error: "This folder's AI setting can't be changed." };
  }
  const current = isAiMode(folder.aiMode) ? folder.aiMode : "off";
  const raising = lower(current, mode as AiMode);
  if (raising && mode !== "off" && !confirmed) {
    const access = await accessTo(viewer, { folderId });
    if (access?.confidential) {
      return { ok: false, error: AI_ON_CONFIDENTIAL, confirm: true };
    }
  }
  await database.$transaction(async (tx) => {
    const target = { folderId };
    const before = await modesOf(tx, orgId, target);
    await tx.folder.updateMany({
      where: { id: folderId, orgId },
      data: { aiMode: mode },
    });
    await settleAiAfterMove(tx, orgId, target, before);
    await audit(
      {
        orgId,
        actorId: userId,
        action: "folder_ai_mode",
        folderId,
        detail: { from: current, to: mode },
      },
      tx
    );
  });
  return { ok: true };
};
