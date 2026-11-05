import "server-only";

import { analytics } from "@repo/analytics/server";
import { log } from "@repo/observability/log";

// Product events, grouped by shop ("company" in PostHog). The north star is
// questions answered + quotes drafted per shop per week (docs/TAKUMO.md
// section 14). Nothing is sent without NEXT_PUBLIC_POSTHOG_KEY.
export const EVENTS = [
  "question_answered",
  "capacity_checked",
  "plan_built",
  "rfq_received",
  "po_received",
  "po_entered",
  "erp_report_received",
  "quote_drafted",
  "quote_approved",
  "quote_outcome",
  "reply_drafted",
  "reply_sent",
  "fact_proposed",
  "fact_reviewed",
  "note_saved",
  "document_emailed",
  "job_logged",
  "data_imported",
  "connector_connected",
  "connector_synced",
  "checkout_started",
  "demo_shop_created",
] as const;
export type EventName = (typeof EVENTS)[number];

export const track = (
  event: EventName,
  {
    orgId,
    userId,
    properties = {},
  }: {
    orgId: string;
    properties?: Record<string, unknown>;
    userId?: string | null;
  }
) => {
  if (!analytics) {
    return;
  }
  try {
    analytics.capture({
      event,
      distinctId: userId ?? `shop:${orgId}`,
      groups: { company: orgId },
      properties,
    });
  } catch (error) {
    log.warn("Analytics event failed", { event, error: String(error) });
  }
};
