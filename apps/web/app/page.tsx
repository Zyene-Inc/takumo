import { Button } from "@repo/design-system/components/ui/button";
import { createMetadata } from "@repo/seo/metadata";
import {
  BrainIcon,
  CalculatorIcon,
  CalendarRangeIcon,
  MessageSquareIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@/env";

export const metadata: Metadata = createMetadata({
  title: "Your shop's master craftsman, in AI form",
  description:
    "Takumo knows your shop, checks your capacity, and tells you whether you can take a job, by when, and at what margin, with the evidence behind every number.",
});

const features = [
  {
    icon: CalendarRangeIcon,
    title: "Can we take this order?",
    body: "Checks the order against your real schedule and capacity. Shows the earliest date, which orders slip, and the cheapest way to make it fit.",
  },
  {
    icon: CalculatorIcon,
    title: "Quotes based on real capacity",
    body: "Reads the RFQ, finds comparable past jobs, and drafts a price and lead time your estimator can approve in minutes.",
  },
  {
    icon: MessageSquareIcon,
    title: "Ask anything, see the source",
    body: "Margins by customer, late-risk orders, bottleneck machines. Every number links back to the data it came from.",
  },
  {
    icon: BrainIcon,
    title: "Keeps your tribal knowledge",
    body: "Setup tricks and corrections from your veterans become reviewed facts that improve the model, instead of retiring with them.",
  },
];

const Home = () => (
  <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-16 px-4 py-24">
    <section className="flex flex-col items-start gap-6">
      <p className="text-muted-foreground text-sm">
        Takumo 匠 · AI operations for job shops
      </p>
      <h1 className="max-w-3xl font-semibold text-4xl tracking-tight md:text-6xl">
        Your shop's master craftsman, in AI form.
      </h1>
      <p className="max-w-2xl text-lg text-muted-foreground">
        Takumo learns your machines, routings, orders and quote history, then
        answers "can we take this job, by when, and at what margin?" with the
        evidence behind every number.
      </p>
      <div className="flex gap-3">
        <Button asChild size="lg">
          <Link href={`${env.NEXT_PUBLIC_APP_URL}/sign-up`}>
            Start with your shop
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/pricing">See pricing</Link>
        </Button>
        <Button asChild size="lg" variant="ghost">
          <Link href="mailto:hello@takumo.ai">Talk to us</Link>
        </Button>
      </div>
    </section>

    <section className="grid gap-6 md:grid-cols-2">
      {features.map((feature) => (
        <div className="rounded-xl border p-6" key={feature.title}>
          <feature.icon className="h-5 w-5 text-muted-foreground" />
          <h2 className="mt-4 font-medium text-lg">{feature.title}</h2>
          <p className="mt-2 text-muted-foreground text-sm">{feature.body}</p>
        </div>
      ))}
    </section>

    <footer className="flex flex-wrap gap-4 border-t pt-6 text-muted-foreground text-sm">
      <span>© {new Date().getFullYear()} Zyene · takumo.ai</span>
      <Link className="hover:underline" href="/pricing">
        Pricing
      </Link>
    </footer>
  </main>
);

export default Home;
