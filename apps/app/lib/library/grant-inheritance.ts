import "server-only";

import { database } from "@repo/database";
import type { Target } from "./access";
import { serialized } from "./access-lock";
import { audit } from "./audit";
import { covers } from "./capabilities";
import {
  auditTarget,
  type ChainGrant,
  freezeAccess,
  inheritedGrants,
  managing,
  type Result,
} from "./grants";
import { trustedViewer, type Viewer } from "./viewer";

/** Who would gain access if `target` inherited from the folder above again. */
export const inheritanceGain = async (
  viewer: Viewer,
  target: Target
): Promise<ChainGrant[]> => {
  const { orgId } = trustedViewer(viewer);
  const [own, above] = await Promise.all([
    database.accessGrant.findMany({
      where: { orgId, ...target },
      select: { principalType: true, principalId: true, capabilities: true },
    }),
    database.$transaction((tx) => inheritedGrants(tx, orgId, target)),
  ]);
  const held = new Map(
    own.map((g) => [`${g.principalType}:${g.principalId}`, g.capabilities])
  );
  return above.filter(
    (g) =>
      !covers(
        held.get(`${g.principal_type}:${g.principal_id}`) ?? 0,
        g.capabilities
      )
  );
};

export type InheritanceResult =
  | Result
  /** Resuming would give access to more people: ask first (UI), then confirm. */
  | { ok: false; confirm: ChainGrant[]; error: string };

/**
 * Stop or resume inheriting access from the folder above. Stopping first
 * copies what it inherits onto it, so nobody loses access by surprise;
 * removing those grants afterwards is a deliberate, separate step.
 * Resuming can give more people access: it needs `confirmed` when it does,
 * and someone other than the owner can only pass on access they hold.
 */
export const setInheritance = serialized(
  async (
    viewer: Viewer,
    target: Target,
    inherit: boolean,
    { confirmed = false }: { confirmed?: boolean } = {}
  ): Promise<InheritanceResult> => {
    const check = await managing(viewer, target);
    if (!check.ok) {
      return check;
    }
    if (inherit) {
      const gain = await inheritanceGain(viewer, target);
      if (
        !viewer.isOwner &&
        gain.some((g) => !covers(check.access.capabilities, g.capabilities))
      ) {
        return {
          ok: false,
          error: "You can only give access you have yourself.",
        };
      }
      if (gain.length > 0 && !confirmed) {
        return {
          ok: false,
          confirm: gain,
          error: "This gives more people access. Confirm to go ahead.",
        };
      }
    }
    await database.$transaction(async (tx) => {
      await audit(
        {
          orgId: viewer.orgId,
          actorId: viewer.userId,
          action: "access_inherit",
          ...auditTarget(target),
          detail: { inherit },
        },
        tx
      );
      if (!inherit) {
        await freezeAccess(
          tx,
          viewer.orgId,
          target,
          await inheritedGrants(tx, viewer.orgId, target),
          viewer.userId
        );
        return;
      }
      if ("folderId" in target) {
        await tx.folder.updateMany({
          where: { id: target.folderId, orgId: viewer.orgId },
          data: { inheritAccess: inherit },
        });
      } else {
        await tx.source.updateMany({
          where: { id: target.sourceId, orgId: viewer.orgId },
          data: { inheritAccess: inherit },
        });
      }
    });
    return { ok: true };
  }
);

/**
 * Mark a folder confidential (HR, Finance) or not. Only the owner may: it
 * takes away admins' automatic access to everything inside.
 */
export const setConfidential = serialized(
  async (
    viewer: Viewer,
    folderId: string,
    confidential: boolean
  ): Promise<Result> => {
    if (!trustedViewer(viewer).isOwner) {
      return {
        ok: false,
        error: "Only the shop's owner can mark a folder confidential.",
      };
    }
    const check = await managing(viewer, { folderId });
    if (!check.ok) {
      return check;
    }
    await database.$transaction(async (tx) => {
      if (confidential) {
        // A confidential folder stops inheriting (library.folder_grants, audit
        // H1). Copy what it inherits now onto it first, so the people who can
        // open it today still can, visibly, and grants given later on the
        // folders above never reach it.
        await freezeAccess(
          tx,
          viewer.orgId,
          { folderId },
          await inheritedGrants(tx, viewer.orgId, { folderId }),
          viewer.userId
        );
      }
      await tx.folder.updateMany({
        where: { id: folderId, orgId: viewer.orgId },
        data: { confidential },
      });
      await audit(
        {
          orgId: viewer.orgId,
          actorId: viewer.userId,
          action: "folder_confidential",
          folderId,
          detail: { confidential },
        },
        tx
      );
    });
    return { ok: true };
  }
);
