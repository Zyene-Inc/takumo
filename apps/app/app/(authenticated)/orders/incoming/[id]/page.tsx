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
import { AlertTriangleIcon, FileTextIcon, InfoIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { poSummary } from "@/lib/orders/erp";
import {
  PO_STATUS_LABEL,
  type PoCheck,
  type PoHeader,
  type PoLine,
  type PoStatus,
  poLabel,
} from "@/lib/orders/types";
import { Header } from "../../../components/header";
import { VIEWABLE } from "../../../quotes/[id]/rfq-files";
import { money } from "../../../shop/components/format";
import { PO_STATUS_VARIANT } from "../status";
import { CopySummary, CsvLink, PoButtons } from "./po-actions";

export const metadata: Metadata = { title: "Customer PO · Takumo" };
export const maxDuration = 120;

const Check = ({ check }: { check: PoCheck }) => (
  <p
    className={
      check.severity === "warn"
        ? "flex items-start gap-1.5 text-amber-700 text-xs dark:text-amber-400"
        : "flex items-start gap-1.5 text-muted-foreground text-xs"
    }
  >
    {check.severity === "warn" ? (
      <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
    ) : (
      <InfoIcon className="mt-0.5 size-3 shrink-0" />
    )}
    {check.message}
  </p>
);

const Field = ({ label, value }: { label: string; value: string | null }) => (
  <div>
    <p className="text-muted-foreground text-xs">{label}</p>
    <p className="text-sm">{value ?? "—"}</p>
  </div>
);

/** Which quote a line answers, linked to its RFQ. */
const QuoteCell = ({ quote }: { quote: PoLine["quote"] }) => {
  if (!quote) {
    return "—";
  }
  return quote.rfqId ? (
    <Link className="underline" href={`/quotes/${quote.rfqId}`}>
      {quote.quoteNo}
    </Link>
  ) : (
    quote.quoteNo
  );
};

/** The PO's lines, each with its checks underneath. */
const LinesTable = ({ lines, total }: { lines: PoLine[]; total: number }) => (
  <div className="rounded-xl border">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <TableHead>Part</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Unit price</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead>Due</TableHead>
          <TableHead>Quote</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => (
          <TableRow key={l.lineNo}>
            <TableCell className="align-top">{l.lineNo}</TableCell>
            <TableCell className="max-w-80 align-top">
              <p className="font-medium">
                {l.partNo ?? "—"}
                {l.rev ? ` rev ${l.rev}` : ""}
              </p>
              {l.description && (
                <p className="text-muted-foreground text-xs">{l.description}</p>
              )}
              <div className="mt-1 grid gap-0.5">
                {l.checks.map((c) => (
                  <Check check={c} key={`${c.kind}-${c.message}`} />
                ))}
              </div>
            </TableCell>
            <TableCell className="text-right align-top">
              {l.qty?.toLocaleString("en-US") ?? "—"}
            </TableCell>
            <TableCell className="text-right align-top">
              {l.unitPrice === null ? "—" : money(l.unitPrice)}
            </TableCell>
            <TableCell className="text-right align-top">
              {l.extended === null ? "—" : money(l.extended)}
            </TableCell>
            <TableCell className="align-top">{l.dueDate ?? "—"}</TableCell>
            <TableCell className="align-top">
              <QuoteCell quote={l.quote} />
            </TableCell>
          </TableRow>
        ))}
        <TableRow>
          <TableCell colSpan={4} />
          <TableCell className="text-right font-medium">
            {money(Math.round(total * 100) / 100)}
          </TableCell>
          <TableCell colSpan={2} />
        </TableRow>
      </TableBody>
    </Table>
  </div>
);

const HeaderFields = ({
  customer,
  buyer,
  header,
  received,
}: {
  buyer: string | null;
  customer: string | null;
  header: PoHeader | null;
  received: Date;
}) => (
  <div className="grid gap-4 rounded-xl border p-4 sm:grid-cols-3">
    <Field label="Customer" value={customer} />
    <Field label="Buyer" value={buyer} />
    <Field label="PO date" value={header?.orderDate ?? null} />
    <Field label="Ship to" value={header?.shipTo ?? null} />
    <Field label="Terms" value={header?.terms ?? null} />
    <Field label="Received" value={received.toISOString().slice(0, 10)} />
    {header?.notes && (
      <div className="sm:col-span-3">
        <Field label="Notes on the PO" value={header.notes} />
      </div>
    )}
  </div>
);

const EnteredNote = ({ at, by }: { at: Date | null; by: string | null }) =>
  at ? (
    <span className="text-muted-foreground text-sm">
      {by === "erp" ? "Seen in your ERP's orders report" : "Marked entered"}{" "}
      {at.toISOString().slice(0, 10)}
    </span>
  ) : null;

/** The PO's own file(s): opened in the browser when it can show them. */
const PoFiles = ({
  poId,
  files,
}: {
  files: { id: string; mediaType: string; name: string }[];
  poId: string;
}) =>
  files.length ? (
    <section className="grid gap-2">
      <h2 className="font-semibold">The PO</h2>
      <ul className="grid gap-1 text-sm">
        {files.map((f) => (
          <li className="flex items-center gap-2" key={f.id}>
            <FileTextIcon className="size-4 text-muted-foreground" />
            <a
              className="underline"
              href={`/orders/incoming/${poId}/files/${f.id}${VIEWABLE.includes(f.mediaType) ? "?view=1" : ""}`}
              rel="noopener"
              target="_blank"
            >
              {f.name}
            </a>
          </li>
        ))}
      </ul>
    </section>
  ) : null;

const PoPage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { orgId, canEditQuotes } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const { id } = await params;
  const po = await forOrg(database, orgId).customerPo.findFirst({
    where: { id },
    select: {
      id: true,
      number: true,
      poNo: true,
      status: true,
      error: true,
      customerName: true,
      customerId: true,
      contact: true,
      sender: true,
      subject: true,
      receivedAt: true,
      enteredAt: true,
      enteredBy: true,
      lines: true,
      checks: true,
      extracted: true,
      files: { select: { id: true, name: true, mediaType: true, size: true } },
    },
  });
  if (!po) {
    notFound();
  }
  const status = po.status as PoStatus;
  const lines = (po.lines as PoLine[] | null) ?? [];
  const checks = (po.checks as PoCheck[] | null) ?? [];
  const header = (po.extracted as { header?: PoHeader } | null)?.header;
  const summary = poSummary({
    customer: po.customerName,
    poNo: po.poNo,
    shipTo: header?.shipTo ?? null,
    terms: header?.terms ?? null,
    lines,
  });
  const total = lines.reduce((sum, l) => sum + (l.extended ?? 0), 0);

  return (
    <>
      <Header page={poLabel(po.number)} pages={["Quotes", "Incoming POs"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-semibold text-xl">
            {po.poNo ? `Customer PO ${po.poNo}` : poLabel(po.number)}
          </h1>
          <Badge variant={PO_STATUS_VARIANT[status]}>
            {PO_STATUS_LABEL[status]}
          </Badge>
          <EnteredNote at={po.enteredAt} by={po.enteredBy} />
        </div>
        {canEditQuotes && <PoButtons poId={po.id} status={status} />}
        {po.error && <p className="text-destructive text-sm">{po.error}</p>}

        <HeaderFields
          buyer={po.contact ?? po.sender}
          customer={po.customerName}
          header={header ?? null}
          received={po.receivedAt}
        />

        {checks.length > 0 && (
          <div className="grid gap-1 rounded-xl border border-amber-300 border-dashed p-4 dark:border-amber-700">
            {checks.map((c) => (
              <Check check={c} key={`${c.kind}-${c.message}`} />
            ))}
          </div>
        )}

        {lines.length > 0 && <LinesTable lines={lines} total={total} />}

        {lines.length > 0 && status !== "rejected" && (
          <section className="grid gap-2 rounded-xl border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="flex-1 font-semibold">Ready for your ERP</h2>
              <CopySummary text={summary} />
              <CsvLink poId={po.id} />
            </div>
            <p className="text-muted-foreground text-sm">
              Enter this as a sales order in your ERP (or import the CSV).
              Takumo marks it entered once the ERP's nightly report shows it.
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs">
              {summary}
            </pre>
          </section>
        )}

        <PoFiles files={po.files} poId={po.id} />
        {po.subject && (
          <p className="text-muted-foreground text-xs">
            From {po.sender ?? "—"}: {po.subject}
          </p>
        )}
      </div>
    </>
  );
};

export default PoPage;
