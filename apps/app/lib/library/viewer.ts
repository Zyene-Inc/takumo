import "server-only";

import { auth, shopRole } from "@repo/auth/server";
import { database } from "@repo/database";

/**
 * Who is asking, as the Knowledge Hub's permission checks see them.
 *
 * Only this module makes viewers, and only from facts verified on the server
 * for this request: the signed-in user, their active WorkOS membership and
 * role, and the shop's recorded owner. Viewers are frozen and remembered, and
 * every check refuses anything else (trustedViewer), so an object built from
 * request data can never stand in for one. The database works out
 * departments and ownership again itself (library.who); a viewer only tells
 * it the shop, the user and the role.
 */
export interface Viewer {
  /** May do everything outside confidential folders. */
  readonly isAdmin: boolean;
  /** The shop's recorded owner: may do everything. */
  readonly isOwner: boolean;
  /** Background work (crons, the shop brief): sees only what everyone may. */
  readonly isSystem: boolean;
  readonly orgId: string;
  /** WorkOS role slug of an active member; null for background work. */
  readonly role: string | null;
  readonly userId: string | null;
}

// WorkOS role slugs that administer a shop (library.who agrees).
const ADMIN_ROLES = new Set(["owner", "admin"]);

const issued = new WeakSet<Viewer>();

const issue = (viewer: Viewer): Viewer => {
  const frozen = Object.freeze({ ...viewer });
  issued.add(frozen);
  return frozen;
};

/** The viewer itself, when this module made it; throws otherwise. */
export const trustedViewer = (viewer: Viewer): Viewer => {
  if (!issued.has(viewer)) {
    throw new Error("Access checks need a viewer made on the server.");
  }
  return viewer;
};

/** Background work: only what everyone in the shop may see. */
export const systemViewer = (orgId: string): Viewer =>
  issue({
    orgId,
    userId: null,
    role: null,
    isOwner: false,
    isAdmin: false,
    isSystem: true,
  });

/** For a member whose role was just read from WorkOS. */
const memberViewer = async (orgId: string, userId: string, role: string) => {
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: { ownerUserId: true },
  });
  if (!org) {
    return null;
  }
  return issue({
    orgId,
    userId,
    role,
    // The owner on record, while still an admin: an owner who was removed
    // and invited back with a lesser role isn't the owner (security audit L3).
    isOwner: org.ownerUserId === userId && ADMIN_ROLES.has(role),
    isAdmin: ADMIN_ROLES.has(role),
    isSystem: false,
  });
};

/**
 * The signed-in person in their current shop, or null. auth() only names a
 * shop while its WorkOS membership is active, so a stale session gets none.
 */
export const resolveViewer = async (): Promise<Viewer | null> => {
  const { orgId, userId, role } = await auth();
  if (!(orgId && userId && role)) {
    return null;
  }
  return memberViewer(orgId, userId, role);
};

/**
 * A member who isn't signed in here, such as the sender of an email already
 * matched to their account. Their membership and role are read from WorkOS
 * now, never taken from the caller; null when they aren't an active member.
 */
export const viewerForMember = async (
  orgId: string,
  userId: string
): Promise<Viewer | null> => {
  const role = await shopRole(userId, orgId);
  return role ? memberViewer(orgId, userId, role) : null;
};
