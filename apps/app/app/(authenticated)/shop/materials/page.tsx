import { database, forOrg } from "@repo/database";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { PencilIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { Header } from "../../components/header";
import { DeleteButton } from "../components/delete-button";
import {
  EmptyState,
  ErpBadge,
  FilterNote,
  formValue,
  ProvenanceBadge,
  textFilter,
} from "../components/format";
import { RecordDialog } from "../components/record-dialog";
import {
  day,
  type IncomingLine,
  incomingByMaterial,
  isLate,
  qty,
  remaining,
  type StockTotal,
  stockByMaterial,
} from "./stock";

export const metadata: Metadata = { title: "Materials · Takumo" };

const unitCost = (cost: { toString(): string } | null, unit: string) =>
  cost === null
    ? "—"
    : `${Number(cost.toString()).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      })} / ${unit}`;

const StockCell = ({
  stock,
  unit,
}: {
  stock: StockTotal | undefined;
  unit: string;
}) => {
  if (!stock) {
    return <span className="text-muted-foreground">—</span>;
  }
  const free = stock.onHand - stock.allocated;
  return (
    <span title={`As of ${day(stock.asOf)}`}>
      {qty(stock.onHand)} {unit}
      {stock.allocated > 0 && (
        <span className="block text-muted-foreground text-xs">
          {qty(free)} free
        </span>
      )}
    </span>
  );
};

const IncomingCell = ({
  lines,
  unit,
}: {
  lines: IncomingLine[];
  unit: string;
}) => {
  const [next, ...rest] = lines;
  if (!next) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={isLate(next.dueDate) ? "text-destructive" : undefined}
      title={lines
        .map((l) => `${l.poNo}: ${qty(l.qty)} ${unit} due ${day(l.dueDate)}`)
        .join("\n")}
    >
      {qty(next.qty)} {unit} on {day(next.dueDate)}
      {rest.length > 0 && (
        <span className="text-muted-foreground"> +{rest.length} more</span>
      )}
    </span>
  );
};

const MaterialsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) => {
  const { orgId, canEditShop } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const q = textFilter((await searchParams).q);
  const db = forOrg(database, orgId);
  const [materials, stock, openPos] = await Promise.all([
    db.material.findMany({
      where: q ? { name: { contains: q, mode: "insensitive" } } : {},
      orderBy: { name: "asc" },
      include: { _count: { select: { parts: true } } },
    }),
    db.stockLevel.findMany({
      select: {
        materialId: true,
        qtyOnHand: true,
        qtyAllocated: true,
        asOf: true,
      },
    }),
    db.purchaseOrderLine.findMany({
      where: { status: { in: ["open", "partial"] } },
      orderBy: { dueDate: "asc" },
      include: { material: { select: { name: true } } },
    }),
  ]);
  const onHand = stockByMaterial(stock);
  const incoming = incomingByMaterial(openPos);
  const hasStock = stock.length > 0 || openPos.length > 0;

  return (
    <>
      <Header page="Materials" pages={["Shop"]}>
        <div className="px-4">
          <RecordDialog
            canEdit={canEditShop}
            entity="materials"
            title="Add a material"
            trigger={
              <Button size="sm">
                <PlusIcon /> Add material
              </Button>
            }
          />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {q && <FilterNote href="/shop/materials" q={q} />}
        {materials.length === 0 ? (
          <EmptyState>
            No materials yet.{" "}
            <Link className="underline" href="/onboarding?type=materials">
              Upload a materials list
            </Link>{" "}
            or add them one by one.
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Spec</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Lead time</TableHead>
                  {hasStock && (
                    <>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead>Incoming</TableHead>
                    </>
                  )}
                  <TableHead className="text-right">Parts</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {materials.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {m.name}
                        <ProvenanceBadge provenance={m.provenance} />
                        <ErpBadge syncedAt={m.syncedAt} />
                      </div>
                    </TableCell>
                    <TableCell>{m.spec ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {unitCost(m.unitCost, m.unit)}
                    </TableCell>
                    <TableCell className="text-right">
                      {m.leadTimeDays === null ? "—" : `${m.leadTimeDays} days`}
                    </TableCell>
                    {hasStock && (
                      <>
                        <TableCell className="text-right">
                          <StockCell stock={onHand.get(m.id)} unit={m.unit} />
                        </TableCell>
                        <TableCell>
                          <IncomingCell
                            lines={incoming.get(m.id) ?? []}
                            unit={m.unit}
                          />
                        </TableCell>
                      </>
                    )}
                    <TableCell className="text-right">
                      {m._count.parts}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <RecordDialog
                          canEdit={canEditShop && !m.syncedAt}
                          entity="materials"
                          initial={{
                            name: m.name,
                            spec: formValue(m.spec),
                            unitCost: formValue(m.unitCost),
                            unit: m.unit,
                            leadTimeDays: formValue(m.leadTimeDays),
                          }}
                          locked={["name"]}
                          title={`Edit ${m.name}`}
                          trigger={
                            <Button
                              aria-label={`Edit ${m.name}`}
                              size="icon"
                              variant="ghost"
                            >
                              <PencilIcon />
                            </Button>
                          }
                        />
                        <DeleteButton
                          canEdit={canEditShop && !m.syncedAt}
                          entity="materials"
                          id={m.id}
                          name={m.name}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {openPos.length > 0 && (
          <section className="grid gap-2">
            <h2 className="font-semibold text-lg">Open purchase orders</h2>
            <p className="text-muted-foreground text-sm">
              From your ERP. Lines it no longer lists are marked received.
            </p>
            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>PO</TableHead>
                    <TableHead>Material</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">Still to come</TableHead>
                    <TableHead className="text-right">Due</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openPos.map((po) => (
                    <TableRow key={po.id}>
                      <TableCell className="font-medium">
                        {po.poNo}
                        {po.lineNo > 1 ? ` / ${po.lineNo}` : ""}
                      </TableCell>
                      <TableCell>{po.material?.name ?? "—"}</TableCell>
                      <TableCell>{po.supplier ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {qty(remaining(po))} {po.unit ?? ""}
                      </TableCell>
                      <TableCell
                        className={
                          isLate(po.dueDate)
                            ? "text-right text-destructive"
                            : "text-right"
                        }
                      >
                        {day(po.dueDate)}
                        {isLate(po.dueDate) ? " (late)" : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}
      </div>
    </>
  );
};

export default MaterialsPage;
