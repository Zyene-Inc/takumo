import { database, forOrg } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import type { CapacityResponse } from "@repo/engine-client/types";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { erpFeeds, fedByErp } from "@/lib/erp/feeds";
import { CAPACITY_CHECK, type CheckInput } from "@/lib/schedule/plan";
import { Header } from "../../components/header";
import { CheckForm, type PartOption } from "./check-form";

export const metadata: Metadata = { title: "Can we take this order? · Takumo" };
// The engine runs several scenarios.
export const maxDuration = 120;

/** Phase 2 is done when the planner agrees on this many real cases. */
const AGREEMENT_GOAL = 10;

const VERDICT_LABEL: Record<string, string> = {
  agree: "👍 Agreed",
  disagree: "👎 Disagreed",
};

const CheckPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ part?: string; run?: string }>;
}) => {
  const { orgId, canEditShop } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { part: initialPartId, run: runParam } = await searchParams;
  const db = forOrg(database, orgId);

  const [parts, customers, runs] = await Promise.all([
    db.part.findMany({
      where: { routings: { some: {} } },
      orderBy: [{ partNo: "asc" }, { rev: "asc" }],
      select: {
        id: true,
        partNo: true,
        rev: true,
        description: true,
        material: { select: { unit: true, unitCost: true } },
        orders: {
          where: { price: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { price: true, qty: true },
        },
        quotes: {
          where: { status: "won", price: { not: null } },
          orderBy: { quotedAt: "desc" },
          take: 1,
          select: { price: true, qty: true },
        },
      },
    }),
    db.customer.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
    db.scheduleRun.findMany({
      where: { objective: CAPACITY_CHECK },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        createdAt: true,
        input: true,
        output: true,
        verdict: true,
        verdictNote: true,
      },
    }),
  ]);

  const options: PartOption[] = parts.map((p) => {
    const last = p.orders[0] ?? p.quotes[0];
    return {
      id: p.id,
      label: `${p.partNo} rev ${p.rev}${p.description ? ` · ${p.description}` : ""}`,
      materialCost:
        p.material?.unit === "ea" && p.material.unitCost !== null
          ? Number(p.material.unitCost.toString())
          : null,
      unitPrice:
        last?.price && last.qty > 0
          ? Number(last.price.toString()) / last.qty
          : null,
    };
  });

  // A saved check opened from a link (Takumo's email answer, F3.4): its
  // answer is shown with "Add to plan".
  const opened = runParam
    ? await db.scheduleRun.findFirst({
        where: { id: runParam, objective: CAPACITY_CHECK },
        select: { id: true, input: true, output: true },
      })
    : null;
  const initialAnswer = opened?.output
    ? {
        runId: opened.id,
        orderNo: (opened.input as unknown as CheckInput).orderNo,
        result: opened.output as unknown as CapacityResponse,
      }
    : null;

  const judged = runs.filter((r) => r.verdict);
  const agreed = judged.filter((r) => r.verdict === "agree").length;

  return (
    <>
      <Header page="Can we take this order?" pages={["Schedule"]} />
      <div className="flex min-w-0 flex-1 flex-col gap-6 p-4 pt-0">
        {options.length === 0 ? (
          <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground text-sm">
            No parts with routings yet. Upload routings on{" "}
            <a className="underline" href="/onboarding?type=routings">
              Set up your shop
            </a>{" "}
            so Takumo knows how long each part takes.
          </div>
        ) : (
          <CheckForm
            canEdit={canEditShop}
            customers={customers.map((c) => c.name)}
            initialAnswer={initialAnswer}
            initialPartId={
              options.some((o) => o.id === initialPartId)
                ? initialPartId
                : undefined
            }
            ordersFromErp={fedByErp(await erpFeeds(orgId), "orders")}
            parts={options}
          />
        )}

        <section className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">Recent checks</h2>
            <p className="text-muted-foreground text-sm">
              Planner agreed on{" "}
              <span className="font-medium text-foreground">
                {agreed} of {judged.length}
              </span>{" "}
              judged answers · goal: {AGREEMENT_GOAL} real cases
            </p>
          </div>
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No checks yet.</p>
          ) : (
            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Answer</TableHead>
                    <TableHead>Earliest</TableHead>
                    <TableHead>Planner</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => {
                    const input = run.input as unknown as CheckInput;
                    const output =
                      run.output as unknown as CapacityResponse | null;
                    return (
                      <TableRow key={run.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {run.createdAt.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })}
                        </TableCell>
                        <TableCell>
                          <span className="font-medium">
                            {input.qty.toLocaleString()} × {input.partNo}
                          </span>
                          {input.customer && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {input.customer}
                            </span>
                          )}
                          {input.addedOrderNo && (
                            <Badge className="ml-2" variant="secondary">
                              Added as {input.addedOrderNo}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {input.dueDate}
                        </TableCell>
                        <TableCell>
                          {output?.can_take ? (
                            <Badge variant="secondary">Yes</Badge>
                          ) : (
                            <Badge variant="destructive">Not as is</Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {output?.new_order?.completion_date ?? "—"}
                        </TableCell>
                        <TableCell title={run.verdictNote ?? undefined}>
                          {VERDICT_LABEL[run.verdict ?? ""] ?? "—"}
                          {run.verdictNote && (
                            <span className="block max-w-64 truncate text-muted-foreground text-xs">
                              {run.verdictNote}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>
    </>
  );
};

export default CheckPage;
