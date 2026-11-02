import { log } from "@repo/observability/log";
import { after } from "next/server";
import { featureProblem } from "@/lib/billing";
import { handleNotification } from "@/lib/connectors/outlook";
import { outlookSubscriber, syncConnection } from "@/lib/connectors/sync";

// The check runs after the response and can read a few RFQs.
export const maxDuration = 300;

/**
 * Microsoft Graph's new-mail notifications for connected Outlook inboxes
 * (public: Graph proves itself with the subscription's secret clientState).
 */
export const POST = async (
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) => {
  const { provider } = await params;
  if (provider !== "outlook") {
    return new Response("Not found", { status: 404 });
  }
  return handleNotification(request, {
    lookup: outlookSubscriber,
    // Acknowledge first: Graph waits only 3 seconds before retrying.
    schedule: (orgIds) =>
      after(async () => {
        for (const orgId of orgIds) {
          // Shops whose plan no longer includes connectors are left alone.
          if (await featureProblem(orgId, "connectors")) {
            continue;
          }
          const r = await syncConnection(orgId, "outlook");
          if (!r.ok) {
            log.warn("Outlook check after notification failed", { orgId });
          }
        }
      }),
  });
};
