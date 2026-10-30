import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { Button } from "@repo/design-system/components/ui/button";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { setupSteps } from "@/lib/onboarding";
import { Header } from "./components/header";
import { SetupChecklist } from "./components/setup-checklist";

const title = "Takumo";
const description = "Your shop's operations brain.";

export const metadata: Metadata = {
  title,
  description,
};

const App = async () => {
  const { orgId } = await auth();

  if (!orgId) {
    notFound();
  }

  const db = forOrg(database, orgId);

  const [workCenters, parts, openOrders, openQuotes] = await Promise.all([
    db.workCenter.count(),
    db.part.count(),
    db.order.count({ where: { status: "open" } }),
    db.quote.count({ where: { status: "open" } }),
  ]);

  const steps = await setupSteps(orgId);
  const done = steps.filter((s) => s.done).length;
  const empty = workCenters === 0 && parts === 0;

  const stats = [
    { label: "Work centers", value: workCenters },
    { label: "Parts", value: parts },
    { label: "Open orders", value: openOrders },
    { label: "Open quotes", value: openQuotes },
  ];

  return (
    <>
      <Header page="Overview" pages={["Shop"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {done < steps.length && (
          <SetupChecklist done={done} empty={empty} steps={steps} />
        )}
        <div className="grid auto-rows-min gap-4 md:grid-cols-4">
          {stats.map((stat) => (
            <div className="rounded-xl bg-muted/50 p-6" key={stat.label}>
              <p className="text-muted-foreground text-sm">{stat.label}</p>
              <p className="font-semibold text-3xl">{stat.value}</p>
            </div>
          ))}
        </div>
        <div className="flex min-h-[50vh] flex-1 flex-col items-center justify-center gap-3 rounded-xl bg-muted/50 p-6 text-center md:min-h-min">
          <p className="text-muted-foreground">
            "Can we take 500 × P-1001 by next Friday?"
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href="/schedule/check">Check an order</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/schedule">Open the schedule</Link>
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};

export default App;
