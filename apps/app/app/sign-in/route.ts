import { getSignInUrl } from "@repo/auth/server";
import { redirect } from "next/navigation";

// Also set as the "Initiate login URI" in the WorkOS dashboard.
export const GET = async () => {
  redirect(await getSignInUrl());
};
