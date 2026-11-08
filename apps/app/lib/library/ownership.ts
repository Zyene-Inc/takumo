import "server-only";

import { shopRole } from "@repo/auth/server";
import { database } from "@repo/database";
import { trustedViewer, type Viewer } from "./viewer";

// The shop's owner keeps full control of every folder and document,
// including confidential ones. WorkOS gives the creator the admin role, so
// ownership is recorded on Org.ownerUserId and changes only by transfer.

/** Record who created a shop as its owner, unless one is already recorded. */
export const recordShopOwner = (orgId: string, userId: string) =>
  database.org.updateMany({
    where: { id: orgId, ownerUserId: null },
    data: { ownerUserId: userId },
  });

/** The owner hands the shop to another active member. */
export const transferOwnership = async (
  viewer: Viewer,
  toUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> => {
  if (!(trustedViewer(viewer).isOwner && viewer.userId)) {
    return { ok: false, error: "Only the shop's owner can hand it over." };
  }
  if (toUserId === viewer.userId) {
    return { ok: false, error: "You already own this shop." };
  }
  if (!(await shopRole(toUserId, viewer.orgId))) {
    return { ok: false, error: "They need to be in the shop first." };
  }
  // Only if this viewer is still the owner: two transfers can't both win.
  const { count } = await database.org.updateMany({
    where: { id: viewer.orgId, ownerUserId: viewer.userId },
    data: { ownerUserId: toUserId },
  });
  return count === 1
    ? { ok: true }
    : {
        ok: false,
        error: "Ownership changed in the meantime. Reload and try again.",
      };
};
