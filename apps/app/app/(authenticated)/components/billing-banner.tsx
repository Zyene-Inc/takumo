import { cn } from "@repo/design-system/lib/utils";
import Link from "next/link";
import { getBilling } from "@/lib/billing";

/** Days before the trial ends when the reminder starts. */
const REMIND_DAYS = 7;

/** A line at the top of every page when the plan needs attention. */
export const BillingBanner = async ({ orgId }: { orgId: string }) => {
  const { entitlements: e } = await getBilling(orgId);
  let text: string | null = null;
  let urgent = false;
  if (e.state === "trial" && (e.trialDaysLeft ?? 0) <= REMIND_DAYS) {
    text = `Your free trial ends in ${e.trialDaysLeft} day${e.trialDaysLeft === 1 ? "" : "s"}.`;
  } else if (e.state === "expired") {
    text =
      "Your free trial has ended. Your data is safe; choose a plan to keep using Takumo.";
    urgent = true;
  } else if (e.state === "past_due") {
    text = "Your last payment failed. Update your card to keep using Takumo.";
    urgent = true;
  } else if (e.state === "canceled") {
    text =
      "Your subscription has ended. Your data is safe; choose a plan to start again.";
    urgent = true;
  }
  if (!text) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm",
        urgent ? "bg-destructive/10 text-destructive" : "bg-muted"
      )}
    >
      <span>{text}</span>
      <Link className="font-medium underline" href="/settings/billing">
        Plans and billing
      </Link>
    </div>
  );
};
