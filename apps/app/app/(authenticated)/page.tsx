import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { Button } from "@repo/design-system/components/ui/button";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { lateReports } from "@/lib/erp/health";
import { setupSteps } from "@/lib/onboarding";
import { Header } from "./components/header";
import { SetupChecklist } from "./components/setup-checklist";

const title = "Takumo";
const description = "Your shop's operations brain.";

export const metadata: Metadata = {
  title,
  description,
};

interface Attention {
  count: number;
  href: string;
  /** What's waiting, after the count. */
  label: string;
  /** Something is broken rather than waiting. */
  problem?: boolean;
}

/** What's waiting for a person today, most urgent first. */
const needsAttention = async (orgId: string): Promise<Attention[]> => {
  const db = forOrg(database, orgId);
  const [rfqs, posToEnter, factsToApprove, reports, brokenMailboxes] =
    await Promise.all([
      db.rfq.groupBy({
        by: ["status"],
        where: {
          status: { in: ["review", "failed", "drafted", "new_sender"] },
        },
        _count: true,
      }),
      db.customerPo.count({ where: { status: "review" } }),
      db.fact.count({ where: { status: "pending" } }),
      db.erpReport.findMany({
        where: { status: "active" },
        select: {
          name: true,
          status: true,
          lastReceivedAt: true,
          updatedAt: true,
        },
      }),
      db.connection.count({ where: { status: "error" } }),
    ]);
  const rfqCount = (...statuses: string[]) =>
    rfqs
      .filter((r) => statuses.includes(r.status))
      .reduce((sum, r) => sum + r._count, 0);
  const items: Attention[] = [
    {
      label: "ERP reports stopped arriving",
      href: "/settings/integrations/email",
      count: lateReports(reports, new Date()).length,
      problem: true,
    },
    {
      label: "mailboxes need reconnecting",
      href: "/settings/integrations",
      count: brokenMailboxes,
      problem: true,
    },
    {
      label: "draft replies ready to check and send",
      href: "/quotes",
      count: rfqCount("drafted"),
    },
    {
      label: "RFQs to quote",
      href: "/quotes",
      count: rfqCount("review", "failed"),
    },
    {
      label: "customer POs to enter in your ERP",
      href: "/orders/incoming",
      count: posToEnter,
    },
    {
      label: "RFQs from new senders: quote them or not?",
      href: "/quotes?tab=new",
      count: rfqCount("new_sender"),
    },
    {
      label: "facts waiting for approval",
      href: "/knowledge/facts",
      count: factsToApprove,
    },
  ];
  return items.filter((i) => i.count > 0);
};

const App = async () => {
  const { orgId } = await auth();

  if (!orgId) {
    notFound();
  }

  const db = forOrg(database, orgId);
  const [steps, attention, workCenters, parts] = await Promise.all([
    setupSteps(orgId),
    needsAttention(orgId),
    db.workCenter.count(),
    db.part.count(),
  ]);
  const done = steps.filter((s) => s.done).length;
  const empty = workCenters === 0 && parts === 0;

  return (
    <>
      <Header page="Today" pages={["Shop"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {done < steps.length && (
          <SetupChecklist done={done} empty={empty} steps={steps} />
        )}
        <section className="grid gap-2">
          <h2 className="font-semibold text-lg">Needs your attention</h2>
          {attention.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-muted-foreground text-sm">
              All caught up. New RFQs, draft replies and customer POs show up
              here as they arrive.
            </p>
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {attention.map((item) => (
                <li key={item.label}>
                  <Link
                    className={`flex items-baseline gap-3 rounded-xl border p-4 hover:bg-muted/50 ${item.problem ? "border-destructive/50" : ""}`}
                    href={item.href}
                  >
                    <span
                      className={`font-semibold text-2xl ${item.problem ? "text-destructive" : ""}`}
                    >
                      {item.count}
                    </span>
                    <span className="text-sm">{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-muted/50 p-6 text-center">
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
