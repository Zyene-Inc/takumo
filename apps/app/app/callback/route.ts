import { handleAuth } from "@repo/auth/server";

// Must match NEXT_PUBLIC_WORKOS_REDIRECT_URI and the redirect URI
// configured in the WorkOS dashboard (e.g. http://localhost:3000/callback).
export const GET = handleAuth({ returnPathname: "/" });
