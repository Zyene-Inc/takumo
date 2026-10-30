import "server-only";

import { getWorkOS, withAuth } from "@workos-inc/authkit-nextjs";
import { cache } from "react";

export {
  getSignInUrl,
  getSignUpUrl,
  getWorkOS,
  handleAuth,
  refreshSession,
  signOut,
  switchToOrganization,
  withAuth,
} from "@workos-inc/authkit-nextjs";
export type {
  Event as WebhookEvent,
  Organization,
  User,
} from "@workos-inc/node";

/** The small auth surface the rest of Takumo depends on. */
export interface AuthContext {
  orgId: string | null;
  role: string | null;
  userId: string | null;
}

// The access token's `role` claim is "authenticated" because the JWT template
// is shaped for Supabase third-party auth, so the shop role (admin, planner…)
// comes from the WorkOS membership. Cached for the duration of a request.
const membershipRole = cache(
  async (userId: string, organizationId: string): Promise<string | null> => {
    const memberships =
      await getWorkOS().userManagement.listOrganizationMemberships({
        userId,
        organizationId,
        statuses: ["active"],
      });
    return memberships.data[0]?.role.slug ?? null;
  }
);

export const auth = async (): Promise<AuthContext> => {
  const { user, organizationId } = await withAuth();
  const userId = user?.id ?? null;
  const orgId = organizationId ?? null;

  return {
    userId,
    orgId,
    role: userId && orgId ? await membershipRole(userId, orgId) : null,
  };
};

export const currentUser = async () => {
  const { user } = await withAuth();
  return user;
};

export interface UserOrganization {
  id: string;
  name: string;
  role: string;
}

/** Organizations (shops) the user is an active member of. */
export const listUserOrganizations = async (
  userId: string
): Promise<UserOrganization[]> => {
  const workos = getWorkOS();
  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId,
    statuses: ["active"],
  });

  return memberships.data.map((membership) => ({
    id: membership.organizationId,
    name: membership.organizationName,
    role: membership.role.slug,
  }));
};

/** Creates a WorkOS organization and makes `userId` its admin. */
export const createOrganizationForUser = async (
  name: string,
  userId: string
) => {
  const workos = getWorkOS();
  const organization = await workos.organizations.createOrganization({ name });

  await workos.userManagement.createOrganizationMembership({
    organizationId: organization.id,
    userId,
    roleSlug: "admin",
  });

  return organization;
};
