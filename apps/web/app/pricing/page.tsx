import { Button } from "@repo/design-system/components/ui/button";
import {
  FEATURE_LABEL,
  PLANS,
  type PlanKey,
  TRIAL_DAYS,
} from "@repo/payments/plans";
import { createMetadata } from "@repo/seo/metadata";
import { CheckIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@/env";

export const metadata: Metadata = createMetadata({
  title: "Pricing",
  description: `Takumo plans for job shops: Shop $${PLANS.shop.price}/month, Pro $${PLANS.pro.price}/month, and Plant for several sites. ${TRIAL_DAYS}-day free trial.`,
});

const SHOWN: PlanKey[] = ["shop", "pro", "plant"];

const Pricing = () => (
  <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-12 px-4 py-24">
    <section className="flex flex-col gap-4">
      <Link className="text-muted-foreground text-sm" href="/">
        Takumo 匠
      </Link>
      <h1 className="font-semibold text-4xl tracking-tight">Pricing</h1>
      <p className="max-w-2xl text-lg text-muted-foreground">
        Every shop starts with a {TRIAL_DAYS}-day free trial with everything in
        Pro. No card needed to start; your data is yours to export at any time.
      </p>
    </section>

    <section className="grid gap-6 md:grid-cols-3">
      {SHOWN.map((key) => {
        const plan = PLANS[key];
        return (
          <div
            className={`flex flex-col gap-4 rounded-xl border p-6 ${key === "pro" ? "border-primary" : ""}`}
            key={key}
          >
            <div>
              <h2 className="font-medium text-lg">{plan.name}</h2>
              <p className="mt-2 font-semibold text-3xl">
                {plan.price === null
                  ? "Custom"
                  : `$${plan.price.toLocaleString()}`}
                {plan.price !== null && (
                  <span className="font-normal text-base text-muted-foreground">
                    /month
                  </span>
                )}
              </p>
              <p className="mt-2 text-muted-foreground text-sm">
                {plan.summary}
              </p>
            </div>
            <ul className="grid gap-2 text-sm">
              {plan.features.map((f) => (
                <li className="flex items-center gap-2" key={f}>
                  <CheckIcon className="h-4 w-4 text-emerald-600" />{" "}
                  {FEATURE_LABEL[f]}
                </li>
              ))}
              <li className="flex items-center gap-2">
                <CheckIcon className="h-4 w-4 text-emerald-600" />
                {plan.seats === null
                  ? "Unlimited users"
                  : `${plan.seats} users`}
              </li>
            </ul>
            <div className="mt-auto">
              {plan.price === null ? (
                <Button asChild className="w-full" variant="outline">
                  <Link href="mailto:hello@takumo.ai">Talk to us</Link>
                </Button>
              ) : (
                <Button
                  asChild
                  className="w-full"
                  variant={key === "pro" ? "default" : "outline"}
                >
                  <Link href={`${env.NEXT_PUBLIC_APP_URL}/sign-up`}>
                    Start free trial
                  </Link>
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </section>

    <footer className="border-t pt-6 text-muted-foreground text-sm">
      © {new Date().getFullYear()} Zyene · takumo.ai
    </footer>
  </main>
);

export default Pricing;
