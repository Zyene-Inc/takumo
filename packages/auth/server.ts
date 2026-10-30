import "server-only";

import { getWorkOS, withAuth } from "@workos-inc/authkit-nextjs";

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

export const auth = async (): Promise<AuthContext> => {
  const { user, organizationId, role } = await withAuth();

  return {
    userId: user?.id ?? null,
    orgId: organizationId ?? null,
    role: role ?? null,
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
