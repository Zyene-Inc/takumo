import { getSignUpUrl } from "@repo/auth/server";
import { redirect } from "next/navigation";

export const GET = async () => {
  redirect(await getSignUpUrl());
};
