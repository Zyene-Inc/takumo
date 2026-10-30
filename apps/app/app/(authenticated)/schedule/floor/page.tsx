import { database, forOrg } from "@repo/database";
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
import { Header } from "../../components/header";
import { EmptyState } from "../../shop/components/format";
import { LogButton, type LoggableOp, PlanLink, UndoButton } from "./log-form";

export const metadata: Metadata = { title: "Shop floor · Takumo" };
// A note with a log is read by Claude.
export const maxDuration = 120;

/** Planned operations shown, soonest first. */
const SHOWN = 60;

/** Planned clock times are stored as shop-local time without a zone. */
const local = (value: Date | null) =>
  value ? value.toISOString().slice(0, 16).replace("T", " ") : "—";

const FloorPage = async () => {
  const { orgId, canLogFloor } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const db = forOrg(database, orgId);
  const [planned, recent] = await Promise.all([
    db.job.findMany({
      where: {
        actualEnd: null,
        plannedStart: { not: null },
        order: { status: { in: ["open", "in_progress"] } },
      },
      orderBy: { plannedStart: "asc" },
      take: SHOWN,
      select: {
        id: true,
        routingSeq: true,
        plannedStart: true,
        workCenterId: true,
        order: {
          select: {
            id: true,
            orderNo: true,
            qty: true,
            part: {
              select: {
                partNo: true,
                routings: {
                  select: {
                    seq: true,
                    setupMin: true,
                    runMinPerUnit: true,
                    workCenter: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
    db.job.findMany({
      where: { actualEnd: { not: null }, loggedBy: { not: null } },
      orderBy: { actualEnd: "desc" },
      take: 20,
      select: {
        id: true,
        routingSeq: true,
        actualEnd: true,
        actualSetupMin: true,
        actualRunMin: true,
        qtyGood: true,
        qtyScrap: true,
        plannedSetupMin: true,
        order: {
          select: { orderNo: true, part: { select: { partNo: true } } },
        },
      },
    }),
  ]);
  const machines = new Map(
    (await db.workCenter.findMany({ select: { id: true, name: true } })).map(
      (w) => [w.id, w.name]
    )
  );
  const ops: (LoggableOp & { id: string; plannedStart: Date | null })[] =
    planned.flatMap((j) => {
      const op = j.order.part.routings.find((r) => r.seq === j.routingSeq);
      return op
        ? [
            {
              id: j.id,
              plannedStart: j.plannedStart,
              orderId: j.order.id,
              orderNo: j.order.orderNo,
              partNo: j.order.part.partNo,
              qty: j.order.qty,
              seq: j.routingSeq,
              machine:
                (j.workCenterId && machines.get(j.workCenterId)) ||
                op.workCenter.name,
              setupMin: op.setupMin,
              runMinPerUnit: op.runMinPerUnit,
            },
          ]
        : [];
    });

  return (
    <>
      <Header page="Shop floor" pages={["Schedule"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          Log what each operation actually took. Takumo compares it with the
          routing to correct setup and run times (see{" "}
          <Link className="underline" href="/knowledge/calibration">
            Calibration
          </Link>
          ), and re-planning schedules only the operations still left.
        </p>
        <h2 className="font-medium">Planned operations</h2>
        {ops.length === 0 ? (
          <EmptyState>
            Nothing planned. Open orders show up here once you <PlanLink />.
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Planned start</TableHead>
                  <TableHead>Machine</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Part</TableHead>
                  <TableHead className="text-right">Op</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {ops.map((op) => (
                  <TableRow key={op.id}>
                    <TableCell>{local(op.plannedStart)}</TableCell>
                    <TableCell>{op.machine}</TableCell>
                    <TableCell className="font-medium">{op.orderNo}</TableCell>
                    <TableCell>{op.partNo}</TableCell>
                    <TableCell className="text-right">{op.seq}</TableCell>
                    <TableCell className="text-right">
                      {op.qty.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {canLogFloor && <LogButton op={op} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <h2 className="font-medium">Recently logged</h2>
        {recent.length === 0 ? (
          <EmptyState>Nothing logged yet.</EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Finished</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Part</TableHead>
                  <TableHead className="text-right">Op</TableHead>
                  <TableHead className="text-right">Setup (planned)</TableHead>
                  <TableHead className="text-right">Run</TableHead>
                  <TableHead className="text-right">Good / scrap</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>{local(j.actualEnd)}</TableCell>
                    <TableCell className="font-medium">
                      {j.order.orderNo}
                    </TableCell>
                    <TableCell>{j.order.part.partNo}</TableCell>
                    <TableCell className="text-right">{j.routingSeq}</TableCell>
                    <TableCell className="text-right">
                      {j.actualSetupMin} min
                      {j.plannedSetupMin !== null && (
                        <span className="text-muted-foreground">
                          {" "}
                          ({j.plannedSetupMin})
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {j.actualRunMin} min
                    </TableCell>
                    <TableCell className="text-right">
                      {j.qtyGood} / {j.qtyScrap}
                    </TableCell>
                    <TableCell>
                      {canLogFloor && (
                        <UndoButton
                          jobId={j.id}
                          label={`${j.order.orderNo} op ${j.routingSeq}`}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
};

export default FloorPage;
