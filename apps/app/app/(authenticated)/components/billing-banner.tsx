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
        "flex min-h-8 shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-[12.5px]",
        urgent
          ? "border-red-100 bg-red-50 text-red-700"
          : "border-sky-100 bg-sky-50 text-sky-800"
      )}
    >
      <span>{text}</span>
      <Link
        className="font-medium underline underline-offset-2"
        href="/settings/billing"
      >
        Plans and billing
      </Link>
    </div>
  );
};
