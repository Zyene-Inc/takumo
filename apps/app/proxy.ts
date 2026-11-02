import { authMiddleware } from "@repo/auth/proxy";
import {
  noseconeOptions,
  noseconeOptionsWithToolbar,
  securityMiddleware,
} from "@repo/security/proxy";
import type { NextProxy } from "next/server";
import { env } from "./env";

const securityHeaders = env.FLAGS_SECRET
  ? securityMiddleware(noseconeOptionsWithToolbar)
  : securityMiddleware(noseconeOptions);

// WorkOS AuthKit manages the session; everything except these paths
// requires a signed-in user. Cron routes check CRON_SECRET themselves; the
// health check reveals only up/down. Microsoft Graph posts Outlook
// notifications (checked by their secret clientState), and a shop's IT person
// lands on the admin-consent page without a Takumo account.
export default authMiddleware(() => securityHeaders(), {
  publicPaths: [
    "/sign-in",
    "/sign-up",
    "/callback",
    "/.well-known",
    "/api/cron",
    "/api/health",
    "/api/connectors/outlook/notify",
    "/api/connectors/outlook/admin-consent",
  ],
}) as unknown as NextProxy;

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
