import { database, forOrg } from "@repo/database";
import { Badge } from "@repo/design-system/components/ui/badge";
import type { ColumnMapping, EntityKey } from "@repo/ingest";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/env";
import { getAccess } from "@/lib/access";
import { changesForErp } from "@/lib/erp/changes";
import type { ReportResult } from "@/lib/erp/reports";
import { ensureAddresses } from "@/lib/inbound/process";
import { addressFor, type InboundKind } from "@/lib/inbound/verify";
import { Header } from "../../../components/header";
import { AddressCard } from "./address-card";
import { ReportRow, type ReportView } from "./report-row";

export const metadata: Metadata = { title: "Email & ERP reports · Takumo" };

const MESSAGES_SHOWN = 15;
const SAMPLE_ROWS = 5;

const STATUS_TEXT: Record<string, string> = {
  received: "Received",
  processed: "Done",
  needs_mapping: "Needs a check",
  rejected: "Bounced",
  failed: "Failed",
};

const ADDRESS_COPY: Record<
  InboundKind,
  { title: string; description: string }
> = {
  erp: {
    title: "ERP reports",
    description:
      "Have your ERP email its nightly reports here (open jobs, parts and routings, customers, materials, stock, purchase orders, operators) as CSV or Excel. Takumo keeps everything up to date from them; nobody types anything twice.",
  },
  rfq: {
    title: "RFQs",
    description:
      "Forward RFQs from customer portals, website forms or anywhere else here. Each one becomes an RFQ in Quotes, read and ready to price, like the ones from your mailbox.",
  },
};

const cell = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).slice(0, 60);
};

const summary = (result: unknown) => {
  const r = result as ReportResult | null;
  if (!r) {
    return null;
  }
  return `${r.created} added, ${r.updated} updated, ${r.skipped} skipped${r.closed ? `, ${r.closed} closed` : ""}`;
};

const detailText = (detail: unknown) => {
  const d = detail as {
    error?: string;
    reports?: string[];
    rfq?: number;
  } | null;
  if (!d) {
    return "";
  }
  if (d.error) {
    return d.error;
  }
  if (d.rfq) {
    return `RFQ-${String(d.rfq).padStart(4, "0")}`;
  }
  return d.reports?.join(" · ") ?? "";
};

const badgeVariant = (status: string) => {
  if (status === "processed") {
    return "secondary" as const;
  }
  return status === "received"
    ? ("outline" as const)
    : ("destructive" as const);
};

const when = (d: Date) =>
  d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const EmailIntegrationsPage = async () => {
  const { orgId, canManageConnectors } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const db = forOrg(database, orgId);
  const domain = env.INBOUND_EMAIL_DOMAIN ?? null;
  const [addresses, reports, messages, changes] = await Promise.all([
    domain ? ensureAddresses(orgId) : db.inboundAddress.findMany(),
    db.erpReport.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] }),
    db.inboundMessage.findMany({
      orderBy: { receivedAt: "desc" },
      take: MESSAGES_SHOWN,
    }),
    changesForErp(orgId),
  ]);

  const reportViews: ReportView[] = reports.map((r) => {
    const mapping = r.mapping as ColumnMapping | null;
    const pending = r.pending as { rows?: Record<string, unknown>[] } | null;
    return {
      id: r.id,
      name: r.name,
      entity: r.entity as EntityKey,
      status: r.status as ReportView["status"],
      mode: r.mode === "changes" ? "changes" : "full",
      headers: r.headers,
      columns: { ...(mapping?.columns ?? {}) },
      timeUnits: { ...(mapping?.timeUnits ?? {}) },
      sample: (pending?.rows ?? [])
        .slice(0, SAMPLE_ROWS)
        .map((row) =>
          Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)]))
        ),
      waitingRows: pending?.rows?.length ?? 0,
      lastReceivedAt: r.lastReceivedAt?.toISOString() ?? null,
      lastImportAt: r.lastImportAt?.toISOString() ?? null,
      lastSummary: summary(r.lastResult),
    };
  });

  return (
    <>
      <Header page="Email & ERP reports" pages={["Settings", "Integrations"]} />
      <div className="flex flex-1 flex-col gap-6 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          Two email addresses for your shop. Your ERP sends its reports to one,
          and anything that should become an RFQ goes to the other. Your ERP
          stays the system of record: what it sends is read-only in Takumo.{" "}
          <Link className="underline" href="/settings/integrations">
            Mailbox and QuickBooks connections
          </Link>
        </p>

        <div className="grid gap-4 lg:grid-cols-2">
          {(["erp", "rfq"] as const).map((kind) => {
            const a = addresses.find((x) => x.kind === kind);
            return (
              <AddressCard
                canManage={canManageConnectors}
                key={kind}
                view={{
                  kind,
                  ...ADDRESS_COPY[kind],
                  address:
                    a && domain ? addressFor(kind, a.token, domain) : null,
                  allowedSenders: a?.allowedSenders ?? [],
                }}
              />
            );
          })}
        </div>

        <section className="grid gap-3">
          <h2 className="font-semibold text-lg">Reports from your ERP</h2>
          {reportViews.length === 0 ? (
            <div className="grid gap-2 rounded-xl border border-dashed p-6 text-muted-foreground text-sm">
              <p>
                No reports yet. In your ERP, schedule these reports to be
                emailed every night, as CSV or Excel, to the ERP reports address
                above:
              </p>
              <ul className="list-disc pl-5">
                <li>Machines / work centers</li>
                <li>Parts and routings</li>
                <li>Customers and materials</li>
                <li>Open jobs or work orders</li>
                <li>Stock on hand and open purchase orders</li>
                <li>Employees / operators and the machines they run</li>
              </ul>
              <p>
                The first time each report arrives, you check what its columns
                mean (Takumo suggests it); after that it imports by itself.
              </p>
            </div>
          ) : (
            <ul className="grid gap-3">
              {reportViews.map((r) => (
                <ReportRow
                  canManage={canManageConnectors}
                  key={r.id}
                  report={r}
                />
              ))}
            </ul>
          )}
        </section>

        {changes.length > 0 && (
          <section className="grid gap-3">
            <h2 className="font-semibold text-lg">
              Changes to copy into your ERP
            </h2>
            <p className="max-w-3xl text-muted-foreground text-sm">
              These approved facts changed records that come from your ERP. Make
              the same change there, or the next report will put the old value
              back.
            </p>
            <ul className="grid gap-1 text-sm">
              {changes.map((c) => (
                <li className="flex flex-wrap gap-2" key={c.fact}>
                  <Badge variant="outline">{c.fact}</Badge>
                  <span className="font-medium">{c.label}</span>
                  <span>{c.what}</span>
                  <span className="text-muted-foreground">
                    approved {when(new Date(c.reviewedAt))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="grid gap-3">
          <h2 className="font-semibold text-lg">Recent messages</h2>
          {messages.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing received yet.
            </p>
          ) : (
            <ul className="grid gap-2">
              {messages.map((m) => (
                <li
                  className="grid gap-0.5 rounded-lg border px-3 py-2 text-sm"
                  key={m.id}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={badgeVariant(m.status)}>
                      {STATUS_TEXT[m.status] ?? m.status}
                    </Badge>
                    <span className="text-muted-foreground">
                      {m.kind === "erp" ? "ERP report" : "RFQ"} ·{" "}
                      {when(m.receivedAt)}
                    </span>
                    <span className="truncate">
                      {m.fromAddress ?? "unknown sender"}
                      {m.subject ? `: ${m.subject}` : ""}
                    </span>
                  </div>
                  {detailText(m.detail) && (
                    <p className="text-muted-foreground">
                      {detailText(m.detail)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
};

export default EmailIntegrationsPage;
