import "server-only";

import { auth } from "@repo/auth/server";
import { env } from "@/env";

/** Takumo staff: WorkOS user ids in ADMIN_USER_IDS (comma separated). */
const isAdmin = (userId: string | null) =>
  Boolean(
    userId &&
      (env.ADMIN_USER_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .includes(userId)
  );

export const requireAdmin = async () => {
  const { userId } = await auth();
  return isAdmin(userId) ? userId : null;
};
