import "server-only";

import { can, type Permission, rolesWith } from "@repo/auth/permissions";
import { auth } from "@repo/auth/server";
import type { EntityKey } from "@repo/ingest";

/** Quotes are the estimators' domain; everything else belongs to planning. */
export const permissionFor = (entity: EntityKey): Permission =>
  entity === "quotes" ? "quotes:write" : "shop:write";

export const NO_ACCESS_MESSAGE: Record<Permission, string> = {
  "shop:write": `Only ${rolesWith("shop:write").join(" or ")}s can change shop data. Ask an admin to change your role.`,
  "quotes:write": `Only ${rolesWith("quotes:write").join(" or ")}s can change quotes. Ask an admin to change your role.`,
};

/** The current shop and what the signed-in user may change in it. */
export const getAccess = async () => {
  const { orgId, role } = await auth();
  return {
    orgId,
    role,
    canEditShop: can(role, "shop:write"),
    canEditQuotes: can(role, "quotes:write"),
  };
};

/**
 * For server actions: the shop id when the user holds `permission`,
 * otherwise an error message to show instead of doing anything.
 */
export const authorize = async (
  permission: Permission
): Promise<{ ok: true; orgId: string } | { ok: false; error: string }> => {
  const { orgId, role } = await auth();
  if (!orgId) {
    return { ok: false, error: "Choose a shop first." };
  }
  if (!can(role, permission)) {
    return { ok: false, error: NO_ACCESS_MESSAGE[permission] };
  }
  return { ok: true, orgId };
};
