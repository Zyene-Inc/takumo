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
import { formatHours, percent, quoteMetrics } from "@/lib/quotes/metrics";
import {
  ACCEPTANCE_TARGET,
  SMALL_LEAD_TIME_EDIT_DAYS,
  SMALL_PRICE_EDIT,
} from "@/lib/quotes/numbers";
import {
  type RfqSource,
  type RfqStatus,
  rfqLabel,
  SOURCE_LABEL,
  STATUS_LABEL,
} from "@/lib/quotes/types";
import { Header } from "../components/header";
import { EmptyState, isoDate, money } from "../shop/components/format";
import { NewRfq } from "./new-rfq";
import { STATUS_VARIANT } from "./status";

export const metadata: Metadata = { title: "RFQ inbox · Takumo" };
// Reading an RFQ calls Claude.
export const maxDuration = 120;

const OPEN: RfqStatus[] = ["reading", "review", "drafted", "failed"];
const CLOSED: RfqStatus[] = ["won", "lost", "declined"];

const TABS = [
  { key: "open", label: "To quote", statuses: OPEN },
  { key: "quoted", label: "Quoted", statuses: ["quoted"] as RfqStatus[] },
  { key: "closed", label: "Closed", statuses: CLOSED },
  { key: "all", label: "All", statuses: null },
] as const;

const channelLabel = (source: string) =>
  SOURCE_LABEL[source as RfqSource] ?? source;

const num = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());

/** Timing metrics look at RFQs from this far back. */
const METRIC_DAYS = 90;

const Metric = ({
  label,
  value,
  detail,
  hint,
}: {
  detail?: string;
  hint?: string;
  label: string;
  value: string;
}) => (
  <div className="rounded-xl border p-4">
    <p className="text-muted-foreground text-sm">{label}</p>
    <p className="mt-1 font-semibold text-2xl">
      {value}
      {detail && (
        <span className="ml-2 font-normal text-muted-foreground text-sm">
          {detail}
        </span>
      )}
    </p>
    {hint && <p className="mt-1 text-muted-foreground text-xs">{hint}</p>}
  </div>
);

const RfqInboxPage = async ({
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
  const metricsSince = new Date(Date.now() - METRIC_DAYS * 86_400_000);
  const [rfqs, counts, drafted, timings] = await Promise.all([
    db.rfq.findMany({
      where: tab.statuses ? { status: { in: [...tab.statuses] } } : {},
      orderBy: [{ receivedAt: "desc" }],
      take: 200,
      select: {
        id: true,
        number: true,
        status: true,
        subject: true,
        source: true,
        receivedAt: true,
        _count: { select: { files: true } },
        requestedDate: true,
        customerName: true,
        customer: { select: { name: true } },
        lines: {
          orderBy: { lineNo: "asc" },
          select: { partNo: true, description: true },
        },
        quotes: { select: { price: true } },
      },
    }),
    db.rfq.groupBy({ by: ["status"], _count: true }),
    db.quote.findMany({
      where: { draftPrice: { not: null } },
      select: {
        price: true,
        draftPrice: true,
        leadTimeDays: true,
        draftLeadTimeDays: true,
        estCost: true,
        status: true,
      },
    }),
    db.rfq.findMany({
      where: { receivedAt: { gte: metricsSince } },
      select: { receivedAt: true, draftedAt: true, sentAt: true },
    }),
  ]);
  const countOf = (statuses: readonly RfqStatus[] | null) =>
    counts
      .filter((c) => !statuses || statuses.includes(c.status as RfqStatus))
      .reduce((sum, c) => sum + c._count, 0);
  const metrics = quoteMetrics(
    timings,
    drafted.map((q) => ({
      price: num(q.price),
      draftPrice: num(q.draftPrice),
      leadTimeDays: q.leadTimeDays,
      draftLeadTimeDays: q.draftLeadTimeDays,
      estCost: num(q.estCost),
      status: q.status,
    }))
  );
  const measure = metrics.smallEdits;

  return (
    <>
      <Header page="RFQ inbox" pages={["Quotes"]}>
        <div className="flex gap-2 px-4">
          <NewRfq canEdit={canEditQuotes} />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="To quote" value={String(countOf(OPEN))} />
          <Metric
            detail={
              metrics.rfqsDrafted
                ? `median of ${metrics.rfqsDrafted}`
                : undefined
            }
            hint={`RFQ arriving to the draft reply being ready, last ${METRIC_DAYS} days.`}
            label="Time to draft"
            value={formatHours(metrics.hoursToDraft)}
          />
          <Metric
            detail={
              metrics.rfqsSent ? `median of ${metrics.rfqsSent}` : undefined
            }
            hint={`RFQ arriving to the reply going out, last ${METRIC_DAYS} days.`}
            label="Time to send"
            value={formatHours(metrics.hoursToSent)}
          />
          <Metric
            detail={
              measure.drafted
                ? `${measure.accepted} of ${measure.drafted} · goal ${Math.round(ACCEPTANCE_TARGET * 100)}%`
                : `goal ${Math.round(ACCEPTANCE_TARGET * 100)}%`
            }
            hint={`Price within ${Math.round(SMALL_PRICE_EDIT * 100)}% and lead time within ${SMALL_LEAD_TIME_EDIT_DAYS} days of Takumo's draft.`}
            label="Drafts sent with small edits"
            value={percent(measure.rate)}
          />
          <Metric
            detail={
              metrics.win.decided
                ? `${metrics.win.won} of ${metrics.win.decided} decided`
                : "none decided yet"
            }
            label="Win rate on drafted quotes"
            value={percent(metrics.win.rate)}
          />
          <Metric
            detail={
              metrics.marginQuotes
                ? `over ${metrics.marginQuotes} quotes`
                : undefined
            }
            hint="Price less estimated cost, as a share of price."
            label="Average margin"
            value={percent(metrics.margin)}
          />
        </div>

        <nav className="flex gap-2">
          {TABS.map((t) => (
            <Button
              asChild
              key={t.key}
              size="sm"
              variant={t.key === tab.key ? "secondary" : "ghost"}
            >
              <Link
                href={t.key === "open" ? "/quotes" : `/quotes?tab=${t.key}`}
              >
                {t.label} ({countOf(t.statuses)})
              </Link>
            </Button>
          ))}
        </nav>

        {rfqs.length === 0 ? (
          <EmptyState>
            {tab.key === "open" ? (
              <>
                Nothing to quote. When an RFQ comes in, paste the email or
                upload it: Takumo reads it, finds comparable past jobs, and
                drafts a price and lead time for you to approve.
              </>
            ) : (
              "No RFQs here."
            )}
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>RFQ</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Parts</TableHead>
                  <TableHead>Needed by</TableHead>
                  <TableHead className="text-right">Quoted</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rfqs.map((rfq) => {
                  const status = rfq.status as RfqStatus;
                  const parts = rfq.lines.map(
                    (l) => l.partNo ?? l.description ?? "—"
                  );
                  const quoted = rfq.quotes.reduce(
                    (sum, q) => sum + (num(q.price) ?? 0),
                    0
                  );
                  return (
                    <TableRow key={rfq.id}>
                      <TableCell className="font-medium">
                        <Link
                          className="hover:underline"
                          href={`/quotes/${rfq.id}`}
                        >
                          {rfqLabel(rfq.number)}
                        </Link>
                        {rfq.subject && (
                          <p className="max-w-64 truncate font-normal text-muted-foreground text-xs">
                            {rfq.subject}
                          </p>
                        )}
                        <p className="font-normal text-muted-foreground text-xs">
                          {channelLabel(rfq.source)}
                          {rfq._count.files > 0 &&
                            ` · ${rfq._count.files} file${rfq._count.files === 1 ? "" : "s"}`}
                        </p>
                      </TableCell>
                      <TableCell>{isoDate(rfq.receivedAt)}</TableCell>
                      <TableCell>
                        {rfq.customer?.name ?? rfq.customerName ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-56 truncate">
                        {parts.length
                          ? `${parts.slice(0, 3).join(", ")}${parts.length > 3 ? ` +${parts.length - 3}` : ""}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {rfq.requestedDate ? isoDate(rfq.requestedDate) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {rfq.quotes.length ? money(quoted) : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[status]}>
                          {STATUS_LABEL[status]}
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

export default RfqInboxPage;
