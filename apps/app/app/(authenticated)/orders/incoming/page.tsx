import { database, forOrg } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import {
  PO_STATUS_LABEL,
  type PoCheck,
  type PoLine,
  type PoStatus,
  poLabel,
} from "@/lib/orders/types";
import { Header } from "../../components/header";
import { EmptyState, isoDate, money } from "../../shop/components/format";
import { NewPo } from "./new-po";
import { PO_STATUS_VARIANT } from "./status";

export const metadata: Metadata = { title: "Incoming POs · Takumo" };
// Reading a PO calls the AI.
export const maxDuration = 120;

const TABS = [
  {
    key: "open",
    label: "To enter",
    statuses: ["reading", "review", "failed"] as PoStatus[],
  },
  { key: "entered", label: "Entered", statuses: ["entered"] as PoStatus[] },
  { key: "rejected", label: "Rejected", statuses: ["rejected"] as PoStatus[] },
  {
    key: "all",
    label: "All",
    statuses: [
      "reading",
      "review",
      "failed",
      "entered",
      "rejected",
    ] as PoStatus[],
  },
] as const;

const warnings = (checks: unknown, lines: unknown) =>
  [
    ...((checks as PoCheck[] | null) ?? []),
    ...((lines as PoLine[] | null) ?? []).flatMap((l) => l.checks),
  ].filter((c) => c.severity === "warn").length;

const total = (lines: unknown) =>
  ((lines as PoLine[] | null) ?? []).reduce(
    (sum, l) => sum + (l.extended ?? 0),
    0
  );

const IncomingPosPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) => {
  const { orgId, canEditQuotes } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { tab: tabKey } = await searchParams;
  const tab = TABS.find((t) => t.key === tabKey) ?? TABS[0];
  const db = forOrg(database, orgId);
  const [pos, counts] = await Promise.all([
    db.customerPo.findMany({
      where: { status: { in: [...tab.statuses] } },
      orderBy: { receivedAt: "desc" },
      take: 200,
      select: {
        id: true,
        number: true,
        poNo: true,
        status: true,
        customerName: true,
        sender: true,
        receivedAt: true,
        lines: true,
        checks: true,
      },
    }),
    db.customerPo.groupBy({ by: ["status"], _count: true }),
  ]);
  const countOf = (statuses: readonly PoStatus[]) =>
    counts
      .filter((c) => statuses.includes(c.status as PoStatus))
      .reduce((sum, c) => sum + c._count, 0);

  return (
    <>
      <Header page="Incoming POs" pages={["Quotes"]}>
        <div className="flex gap-2 px-4">
          <NewPo canEdit={canEditQuotes} />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          Purchase orders from your customers, read and checked against what you
          quoted, laid out ready to enter in your ERP. Takumo doesn't create the
          order: once it's in your ERP, the nightly report marks it entered.
        </p>
        <nav className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <Button
              asChild
              key={t.key}
              size="sm"
              variant={t.key === tab.key ? "secondary" : "ghost"}
            >
              <Link
                href={
                  t.key === "open"
                    ? "/orders/incoming"
                    : `/orders/incoming?tab=${t.key}`
                }
              >
                {t.label} ({countOf(t.statuses)})
              </Link>
            </Button>
          ))}
        </nav>
        {pos.length === 0 ? (
          <EmptyState>
            {tab.key === "open"
              ? "No POs waiting. When a customer emails a PO to a connected mailbox, it shows up here; you can also upload one."
              : "Nothing here."}
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PO</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Checks</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pos.map((po) => {
                  const status = po.status as PoStatus;
                  const lines = (po.lines as PoLine[] | null) ?? [];
                  const flagged = warnings(po.checks, po.lines);
                  return (
                    <TableRow key={po.id}>
                      <TableCell className="font-medium">
                        <Link
                          className="hover:underline"
                          href={`/orders/incoming/${po.id}`}
                        >
                          {poLabel(po.number)}
                        </Link>
                        {po.poNo && (
                          <p className="font-normal text-muted-foreground text-xs">
                            Customer PO {po.poNo}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>{isoDate(po.receivedAt)}</TableCell>
                      <TableCell>
                        {po.customerName ?? po.sender ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {lines.length || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {lines.length ? money(total(po.lines)) : "—"}
                      </TableCell>
                      <TableCell>
                        {flagged > 0 ? (
                          <span className="text-amber-700 text-sm dark:text-amber-400">
                            {flagged} to check
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-sm">
                            {status === "review" ? "Matches the quote" : "—"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={PO_STATUS_VARIANT[status]}>
                          {PO_STATUS_LABEL[status]}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
};

export default IncomingPosPage;
