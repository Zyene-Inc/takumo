import { database } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { entitlements } from "@repo/payments/plans";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { monthlyBudget } from "@/lib/ai-usage";
import { Header } from "../components/header";
import { ExtendTrial } from "./extend-trial";

export const metadata: Metadata = { title: "Admin · Takumo" };

/** Phase 6 is done with this many paying shops (docs/TAKUMO.md section 13). */
const PAYING_GOAL = 3;
const WEEK_MS = 7 * 86_400_000;

const AdminPage = async () => {
  if (!(await requireAdmin())) {
    notFound();
  }
  const since = new Date(Date.now() - WEEK_MS);
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [orgs, questions, drafted, rfqs, members, ai] = await Promise.all([
    database.org.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        plan: true,
        trialEndsAt: true,
        subscriptionStatus: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        createdAt: true,
        _count: { select: { connections: true } },
      },
    }),
    database.message.groupBy({
      by: ["conversationId"],
      where: { role: "user", createdAt: { gte: since } },
      _count: true,
    }),
    database.quote.groupBy({
      by: ["orgId"],
      where: { draftPrice: { not: null }, quotedAt: { gte: since } },
      _count: true,
    }),
    database.rfq.groupBy({
      by: ["orgId"],
      where: { receivedAt: { gte: since } },
      _count: true,
    }),
    database.member.groupBy({ by: ["orgId"], _count: true }),
    database.aiUsage.groupBy({
      by: ["orgId"],
      where: { createdAt: { gte: month } },
      _sum: { costUsd: true },
    }),
  ]);
  const aiSpend = (id: string) =>
    Number(ai.find((r) => r.orgId === id)?._sum.costUsd ?? 0);
  const aiTotal = ai.reduce((sum, r) => sum + Number(r._sum.costUsd ?? 0), 0);
  const budget = monthlyBudget();
  const conversations = await database.conversation.findMany({
    where: { id: { in: questions.map((q) => q.conversationId) } },
    select: { id: true, orgId: true },
  });
  const orgOf = new Map(conversations.map((c) => [c.id, c.orgId]));
  const asked = new Map<string, number>();
  for (const q of questions) {
    const org = orgOf.get(q.conversationId);
    if (org) {
      asked.set(org, (asked.get(org) ?? 0) + q._count);
    }
  }
  const count = (rows: { orgId: string; _count: number }[], id: string) =>
    rows.find((r) => r.orgId === id)?._count ?? 0;

  const shops = orgs.map((o) => ({ ...o, e: entitlements(o) }));
  const paying = shops.filter(
    (s) => s.e.state === "active" && s.plan !== "trial"
  );
  const mrr = paying.reduce((sum, s) => sum + (s.e.plan.price ?? 0), 0);

  return (
    <>
      <Header page="Admin" pages={["Takumo"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border p-4">
            <p className="text-muted-foreground text-sm">Paying shops</p>
            <p className="mt-1 font-semibold text-2xl">
              {paying.length}
              <span className="ml-2 font-normal text-muted-foreground text-sm">
                goal {PAYING_GOAL}
              </span>
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-muted-foreground text-sm">
              Monthly recurring revenue
            </p>
            <p className="mt-1 font-semibold text-2xl">
              ${mrr.toLocaleString()}
            </p>
            <p className="text-muted-foreground text-xs">
              Self-serve plans; Plant is billed separately
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-muted-foreground text-sm">
              North star, last 7 days
            </p>
            <p className="mt-1 font-semibold text-2xl">
              {[...asked.values()].reduce((a, b) => a + b, 0) +
                drafted.reduce((a, b) => a + b._count, 0)}
            </p>
            <p className="text-muted-foreground text-xs">
              Questions asked + quotes sent from drafts
            </p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-muted-foreground text-sm">
              Claude spend this month
            </p>
            <p className="mt-1 font-semibold text-2xl">${aiTotal.toFixed(2)}</p>
            <p className="text-muted-foreground text-xs">
              {budget === null
                ? "No cap per shop (AI_MONTHLY_BUDGET_USD)"
                : `Cap $${budget} per shop`}
            </p>
          </div>
        </div>
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shop</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Trial ends / renews</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Questions (7d)</TableHead>
                <TableHead className="text-right">RFQs (7d)</TableHead>
                <TableHead className="text-right">Quotes sent (7d)</TableHead>
                <TableHead className="text-right">Connectors</TableHead>
                <TableHead className="text-right">Claude $ (month)</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shops.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    {s.name}
                    <p className="font-normal text-muted-foreground text-xs">
                      since {s.createdAt.toISOString().slice(0, 10)}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={s.e.state === "active" ? "default" : "secondary"}
                    >
                      {s.e.plan.name}
                    </Badge>{" "}
                    <span className="text-muted-foreground text-xs">
                      {s.e.state}
                    </span>
                  </TableCell>
                  <TableCell>
                    {(s.plan === "trial" ? s.trialEndsAt : s.currentPeriodEnd)
                      ?.toISOString()
                      .slice(0, 10) ?? "—"}
                    {s.cancelAtPeriodEnd && (
                      <span className="text-destructive text-xs">
                        {" "}
                        cancelling
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {count(members, s.id)}
                  </TableCell>
                  <TableCell className="text-right">
                    {asked.get(s.id) ?? 0}
                  </TableCell>
                  <TableCell className="text-right">
                    {count(rfqs, s.id)}
                  </TableCell>
                  <TableCell className="text-right">
                    {count(drafted, s.id)}
                  </TableCell>
                  <TableCell className="text-right">
                    {s._count.connections}
                  </TableCell>
                  <TableCell className="text-right">
                    {aiSpend(s.id).toFixed(2)}
                    {budget !== null && aiSpend(s.id) >= budget && (
                      <span className="text-destructive text-xs"> capped</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {s.plan === "trial" && <ExtendTrial orgId={s.id} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </>
  );
};

export default AdminPage;
