import { database, forOrg, type QuoteStatus } from "@repo/database";
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
import { PencilIcon, PlusIcon, UploadIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { Header } from "../../components/header";
import { DeleteButton } from "../../shop/components/delete-button";
import {
  EmptyState,
  formValue,
  isoDate,
  money,
} from "../../shop/components/format";
import { RecordDialog } from "../../shop/components/record-dialog";

export const metadata: Metadata = { title: "Past quotes · Takumo" };

const STATUS_VARIANT: Record<QuoteStatus, "default" | "secondary" | "outline"> =
  {
    won: "default",
    lost: "outline",
    open: "secondary",
  };

// Margin on won jobs where both the price and the actual cost are known.
const margin = (
  price: { toString(): string } | null,
  cost: { toString(): string } | null
) => {
  if (price === null || cost === null) {
    return null;
  }
  const p = Number(price.toString());
  return p === 0 ? null : (p - Number(cost.toString())) / p;
};

const PastQuotesPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) => {
  const { orgId, canEditQuotes } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { status } = await searchParams;
  const filter = (["open", "won", "lost"] as const).find((s) => s === status);
  const db = forOrg(database, orgId);
  const [quotes, counts, parts, customers] = await Promise.all([
    db.quote.findMany({
      where: filter ? { status: filter } : {},
      orderBy: [{ quotedAt: "desc" }, { quoteNo: "desc" }],
      include: {
        part: { select: { id: true, partNo: true } },
        customer: { select: { name: true } },
      },
      take: 500,
    }),
    db.quote.groupBy({ by: ["status"], _count: true }),
    db.part.findMany({ orderBy: { partNo: "asc" }, select: { partNo: true } }),
    db.customer.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
  ]);
  const countOf = (s: QuoteStatus) =>
    counts.find((c) => c.status === s)?._count ?? 0;
  const decided = countOf("won") + countOf("lost");
  const winRate = decided === 0 ? null : countOf("won") / decided;
  const options = {
    partNo: [...new Set(parts.map((p) => p.partNo))],
    customer: customers.map((c) => c.name),
  };
  const tabs = [
    { key: undefined, label: "All" },
    { key: "open", label: `Open (${countOf("open")})` },
    { key: "won", label: `Won (${countOf("won")})` },
    { key: "lost", label: `Lost (${countOf("lost")})` },
  ];

  return (
    <>
      <Header page="Past quotes" pages={["Quotes"]}>
        <div className="flex gap-2 px-4">
          {canEditQuotes && (
            <Button asChild size="sm" variant="outline">
              <Link href="/onboarding?type=quotes">
                <UploadIcon /> Upload quotes
              </Link>
            </Button>
          )}
          <RecordDialog
            canEdit={canEditQuotes}
            entity="quotes"
            initial={{
              status: "open",
              quotedAt: new Date().toISOString().slice(0, 10),
            }}
            options={options}
            title="Add a quote"
            trigger={
              <Button size="sm">
                <PlusIcon /> Add quote
              </Button>
            }
          />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <nav className="flex gap-2">
            {tabs.map((tab) => (
              <Button
                asChild
                key={tab.label}
                size="sm"
                variant={tab.key === filter ? "secondary" : "ghost"}
              >
                <Link
                  href={
                    tab.key
                      ? `/quotes/history?status=${tab.key}`
                      : "/quotes/history"
                  }
                >
                  {tab.label}
                </Link>
              </Button>
            ))}
          </nav>
          {winRate !== null && (
            <p className="text-muted-foreground text-sm">
              Win rate {Math.round(winRate * 100)}% of {decided} decided quotes
            </p>
          )}
        </div>
        {quotes.length === 0 ? (
          <EmptyState>
            No quotes here yet. Past quotes, won and lost, are what Takumo
            learns your pricing from.{" "}
            {canEditQuotes && (
              <Link className="underline" href="/onboarding?type=quotes">
                Upload them
              </Link>
            )}
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quote</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Part</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {quotes.map((q) => {
                  const m = margin(q.price, q.actualCost ?? q.estCost);
                  return (
                    <TableRow key={q.id}>
                      <TableCell className="font-medium">{q.quoteNo}</TableCell>
                      <TableCell>{isoDate(q.quotedAt)}</TableCell>
                      <TableCell>{q.customer?.name ?? "—"}</TableCell>
                      <TableCell>
                        {q.part ? (
                          <Link
                            className="hover:underline"
                            href={`/shop/parts/${q.part.id}`}
                          >
                            {q.part.partNo}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {q.qty.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(q.price)}
                      </TableCell>
                      <TableCell className="text-right">
                        {m === null ? "—" : `${Math.round(m * 100)}%`}
                        {m !== null && q.actualCost === null && (
                          <span className="text-muted-foreground"> est.</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[q.status]}>
                          {q.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <RecordDialog
                            canEdit={canEditQuotes}
                            entity="quotes"
                            initial={{
                              quoteNo: q.quoteNo,
                              qty: String(q.qty),
                              customer: formValue(q.customer?.name),
                              partNo: formValue(q.part?.partNo),
                              price: formValue(q.price),
                              leadTimeDays: formValue(q.leadTimeDays),
                              estCost: formValue(q.estCost),
                              actualCost: formValue(q.actualCost),
                              status: q.status,
                              quotedAt: isoDate(q.quotedAt),
                            }}
                            locked={["quoteNo"]}
                            options={options}
                            title={`Edit ${q.quoteNo}`}
                            trigger={
                              <Button
                                aria-label={`Edit ${q.quoteNo}`}
                                size="icon"
                                variant="ghost"
                              >
                                <PencilIcon />
                              </Button>
                            }
                          />
                          <DeleteButton
                            canEdit={canEditQuotes}
                            entity="quotes"
                            id={q.id}
                            name={q.quoteNo}
                          />
                        </div>
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

export default PastQuotesPage;
