import { auth } from "@repo/auth/server";
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
import { notFound } from "next/navigation";
import { Header } from "../../../components/header";
import { DeleteButton } from "../../components/delete-button";
import {
  EmptyState,
  formValue,
  isoDate,
  minutes,
  ProvenanceBadge,
} from "../../components/format";
import { RecordDialog } from "../../components/record-dialog";

export const metadata: Metadata = { title: "Part · Takumo" };

const PartPage = async ({ params }: { params: Promise<{ id: string }> }) => {
  const { orgId } = await auth();
  if (!orgId) {
    notFound();
  }
  const { id } = await params;
  const db = forOrg(database, orgId);
  const part = await db.part.findFirst({
    where: { id },
    include: {
      customer: { select: { name: true } },
      material: { select: { name: true } },
      routings: { orderBy: { seq: "asc" }, include: { workCenter: true } },
      orders: {
        orderBy: { dueDate: "asc" },
        where: { status: { in: ["open", "in_progress"] } },
      },
    },
  });
  if (!part) {
    notFound();
  }
  const [machines, customers, materials] = await Promise.all([
    db.workCenter.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.customer.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
    db.material.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
  ]);
  const machineName = new Map(machines.map((m) => [m.id, m.name]));
  const machineNames = machines.map((m) => m.name);
  const totalRunMin = part.routings.reduce(
    (sum, r) => sum + r.runMinPerUnit,
    0
  );
  const totalSetupMin = part.routings.reduce((sum, r) => sum + r.setupMin, 0);
  const nextSeq = (part.routings.at(-1)?.seq ?? 0) + 10;

  return (
    <>
      <Header
        page={`${part.partNo} rev ${part.rev}`}
        pages={["Shop", "Parts & routings"]}
      >
        <div className="flex gap-1 px-4">
          <RecordDialog
            entity="parts"
            initial={{
              partNo: part.partNo,
              rev: part.rev,
              description: formValue(part.description),
              customer: formValue(part.customer?.name),
              material: formValue(part.material?.name),
            }}
            locked={["partNo", "rev"]}
            options={{
              customer: customers.map((c) => c.name),
              material: materials.map((m) => m.name),
            }}
            title={`Edit ${part.partNo}`}
            trigger={
              <Button size="sm" variant="outline">
                <PencilIcon /> Edit part
              </Button>
            }
          />
          <DeleteButton
            entity="parts"
            id={part.id}
            name={part.partNo}
            redirectTo="/shop/parts"
          />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-6 p-4 pt-0">
        <div className="grid gap-4 md:grid-cols-4">
          {[
            ["Description", part.description ?? "—"],
            ["Customer", part.customer?.name ?? "—"],
            ["Material", part.material?.name ?? "—"],
            [
              "Time per part",
              part.routings.length
                ? `${minutes(totalRunMin)} run + ${minutes(totalSetupMin)} setup per batch`
                : "—",
            ],
          ].map(([label, value]) => (
            <div className="rounded-xl bg-muted/50 p-4" key={label}>
              <p className="text-muted-foreground text-sm">{label}</p>
              <p className="mt-1 font-medium">{value}</p>
            </div>
          ))}
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Routing</h2>
            <RecordDialog
              entity="routings"
              hidden={["partNo", "rev"]}
              initial={{
                partNo: part.partNo,
                rev: part.rev,
                seq: String(nextSeq),
              }}
              options={{ workCenter: machineNames }}
              title={`Add an operation to ${part.partNo}`}
              trigger={
                <Button size="sm">
                  <PlusIcon /> Add operation
                </Button>
              }
            />
          </div>
          {part.routings.length === 0 ? (
            <EmptyState>
              No operations yet. Add them here, or upload a routing file.
            </EmptyState>
          ) : (
            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Op</TableHead>
                    <TableHead>Machine</TableHead>
                    <TableHead className="text-right">Setup</TableHead>
                    <TableHead className="text-right">Run / part</TableHead>
                    <TableHead>Alternates</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {part.routings.map((r) => {
                    const alternates = r.altWorkCenterIds
                      .map((wc) => machineName.get(wc))
                      .filter((n): n is string => Boolean(n));
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.seq}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {r.workCenter.name}
                            <ProvenanceBadge provenance={r.provenance} />
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {minutes(r.setupMin)}
                        </TableCell>
                        <TableCell className="text-right">
                          {minutes(r.runMinPerUnit)}
                        </TableCell>
                        <TableCell>{alternates.join(", ") || "—"}</TableCell>
                        <TableCell>
                          <div className="flex justify-end">
                            <RecordDialog
                              entity="routings"
                              hidden={["partNo", "rev"]}
                              initial={{
                                partNo: part.partNo,
                                rev: part.rev,
                                seq: String(r.seq),
                                workCenter: r.workCenter.name,
                                setupMin: String(r.setupMin),
                                runMinPerUnit: String(r.runMinPerUnit),
                                altWorkCenters: alternates.join(" | "),
                              }}
                              locked={["seq"]}
                              options={{ workCenter: machineNames }}
                              title={`Edit operation ${r.seq}`}
                              trigger={
                                <Button
                                  aria-label={`Edit operation ${r.seq}`}
                                  size="icon"
                                  variant="ghost"
                                >
                                  <PencilIcon />
                                </Button>
                              }
                            />
                            <DeleteButton
                              entity="routings"
                              id={r.id}
                              name={`operation ${r.seq}`}
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
        </section>

        {part.orders.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="font-medium">Open orders</h2>
            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {part.orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">{o.orderNo}</TableCell>
                      <TableCell className="text-right">
                        {o.qty.toLocaleString()}
                      </TableCell>
                      <TableCell>{isoDate(o.dueDate)}</TableCell>
                      <TableCell>{o.status.replace("_", " ")}</TableCell>
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

export default PartPage;
