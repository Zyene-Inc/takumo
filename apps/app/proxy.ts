import { authMiddleware } from "@repo/auth/proxy";
import { noseconeOptions, securityMiddleware } from "@repo/security/proxy";
import type { NextProxy } from "next/server";

const securityHeaders = securityMiddleware(noseconeOptions);

// WorkOS AuthKit manages the session; everything except these paths
// requires a signed-in user. Cron routes check CRON_SECRET themselves; the
// health check reveals only up/down. Microsoft Graph posts Outlook
// notifications (checked by their secret clientState), and a shop's IT person
// lands on the admin-consent page without a Takumo account. Inbound email is
// delivered by our mail receiver, checked by its HMAC signature; texts to the
// shop number by Twilio, checked by its signature. WorkOS and Stripe
// webhooks are checked by their signatures. Brief and alert links carry
// their own signed token.
export default authMiddleware(() => securityHeaders(), {
  publicPaths: [
    "/sign-in",
    "/sign-up",
    "/callback",
    "/.well-known",
    "/api/cron",
    "/api/health",
    "/api/inbound",
    // Links in the morning brief and alerts: signed, and they act only after
    // a confirmation (lib/brief/links.ts).
    "/email",
    "/api/email",
    "/api/twilio",
    "/api/webhooks",
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
