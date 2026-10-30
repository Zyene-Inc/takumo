import { database } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import { FEATURE_LABEL, PLANS, type PlanKey } from "@repo/payments/plans";
import { CheckIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { getBilling } from "@/lib/billing";
import { Header } from "../../components/header";
import { ChoosePlan, ManageBilling } from "./plan-buttons";

export const metadata: Metadata = { title: "Billing · Takumo" };

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const STATE_LABEL: Record<string, string> = {
  trial: "Free trial",
  active: "Active",
  past_due: "Payment failed",
  expired: "Trial ended",
  canceled: "Cancelled",
};

const SHOWN: PlanKey[] = ["shop", "pro", "plant"];

const statusLine = (billing: Awaited<ReturnType<typeof getBilling>>) => {
  const e = billing.entitlements;
  if (e.state === "trial") {
    return `${e.trialDaysLeft} day${e.trialDaysLeft === 1 ? "" : "s"} left, with everything in Pro${
      billing.trialEndsAt ? ` (ends ${DATE.format(billing.trialEndsAt)})` : ""
    }.`;
  }
  if (e.state === "expired") {
    return "Your trial has ended. Your data is all here; choose a plan to use Ask Takumo, Quote Copilot and the rest again.";
  }
  if (e.state === "past_due") {
    return "Your last payment failed. Update your card under Manage billing to keep using Takumo.";
  }
  if (e.state === "canceled") {
    return "Your subscription has ended. Your data is all here; choose a plan to start again.";
  }
  if (billing.cancelAtPeriodEnd && billing.currentPeriodEnd) {
    return `Cancels on ${DATE.format(billing.currentPeriodEnd)}.`;
  }
  return billing.currentPeriodEnd
    ? `Renews on ${DATE.format(billing.currentPeriodEnd)}.`
    : "";
};

const BillingPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) => {
  const { orgId, canManageBilling } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { checkout } = await searchParams;
  const [billing, members] = await Promise.all([
    getBilling(orgId),
    database.member.count({ where: { orgId } }),
  ]);
  const e = billing.entitlements;
  const paying = e.state === "active" || e.state === "past_due";

  return (
    <>
      <Header page="Billing" pages={["Settings"]} />
      <div className="flex flex-1 flex-col gap-6 p-4 pt-0">
        {checkout === "done" && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800 text-sm dark:bg-emerald-950 dark:text-emerald-200">
            Thanks! Your plan is updating; it takes a few seconds.
          </p>
        )}
        <section className="grid gap-2 rounded-xl border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold text-lg">{e.plan.name}</h2>
            <Badge
              variant={
                e.state === "active" || e.state === "trial"
                  ? "secondary"
                  : "destructive"
              }
            >
              {STATE_LABEL[e.state]}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">{statusLine(billing)}</p>
          <p className="text-sm">
            {members} user{members === 1 ? "" : "s"}
            {e.seats !== null && ` of ${e.seats} included`}
            {e.seats !== null && members > e.seats && (
              <span className="text-destructive">
                {" "}
                · over the limit: upgrade to Pro for unlimited users
              </span>
            )}
          </p>
          {canManageBilling && billing.stripeCustomerId && <ManageBilling />}
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {SHOWN.map((key) => {
            const plan = PLANS[key];
            const current = paying && e.plan.key === key;
            return (
              <div
                className="flex flex-col gap-3 rounded-xl border p-4"
                key={key}
              >
                <div>
                  <h3 className="font-semibold">{plan.name}</h3>
                  <p className="mt-1 font-semibold text-2xl">
                    {plan.price === null
                      ? "Custom"
                      : `$${plan.price.toLocaleString()}`}
                    {plan.price !== null && (
                      <span className="font-normal text-muted-foreground text-sm">
                        /month
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-muted-foreground text-sm">
                    {plan.summary}
                  </p>
                </div>
                <ul className="grid gap-1 text-sm">
                  {plan.features.map((f) => (
                    <li className="flex items-center gap-2" key={f}>
                      <CheckIcon className="size-4 text-emerald-600" />{" "}
                      {FEATURE_LABEL[f]}
                    </li>
                  ))}
                  <li className="flex items-center gap-2">
                    <CheckIcon className="size-4 text-emerald-600" />
                    {plan.seats === null
                      ? "Unlimited users"
                      : `${plan.seats} users`}
                  </li>
                </ul>
                <div className="mt-auto">
                  {current && <Badge>Your plan</Badge>}
                  {!current &&
                    canManageBilling &&
                    plan.lookupKey &&
                    !paying && (
                      <ChoosePlan
                        label={`Choose ${plan.name}`}
                        plan={key}
                        primary={key === "pro"}
                      />
                    )}
                  {!current && canManageBilling && plan.lookupKey && paying && (
                    <p className="text-muted-foreground text-sm">
                      Switch plans under Manage billing.
                    </p>
                  )}
                  {!current && key === "plant" && (
                    <p className="text-muted-foreground text-sm">
                      Talk to us to set it up.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </section>
        {!canManageBilling && (
          <p className="text-muted-foreground text-sm">
            Only the shop's owner or an admin can change the plan.
          </p>
        )}
        <section className="grid gap-1 rounded-xl border p-4">
          <h2 className="font-medium">Your data</h2>
          <p className="text-muted-foreground text-sm">
            Everything you've put into Takumo, as CSV files you can open in
            Excel or upload again: machines, parts and routings, orders, quotes,
            job history, facts and notes.
          </p>
          {canManageBilling && (
            <a
              className="justify-self-start text-sm underline"
              download
              href="/api/export"
            >
              Download all data (.zip)
            </a>
          )}
        </section>
      </div>
    </>
  );
};

export default BillingPage;
