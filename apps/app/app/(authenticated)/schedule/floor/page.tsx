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
import { erpFeeds } from "@/lib/erp/feeds";
import {
  byOperation,
  clock,
  crewNames,
  firstDayFrom,
  onDay,
  opKey,
  type PersonDay,
} from "@/lib/schedule/crew";
import { latestPlan } from "@/lib/schedule/plan";
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

/** One person's stretches on the day: when, which machine, which job. */
const PersonCard = ({ person }: { person: PersonDay }) => (
  <div className="rounded-xl border p-3 text-sm">
    <p className="font-medium">
      {person.operator}
      <span className="ml-2 font-normal text-muted-foreground text-xs">
        {Math.round((person.minutes / 60) * 10) / 10} h booked
      </span>
    </p>
    <ul className="mt-1 grid gap-0.5">
      {person.items.map((a) => (
        <li key={`${a.order_no}#${a.seq}@${a.start_at}`}>
          <span className="text-muted-foreground tabular-nums">
            {clock(a.start_at)}–{clock(a.end_at)}
          </span>{" "}
          {a.work_center} · {a.order_no} op {a.seq}
          {a.setup_only && (
            <span className="text-muted-foreground"> (setup only)</span>
          )}
        </li>
      ))}
    </ul>
  </div>
);

/** The plan's people for one day: who runs what, when (F3.3 v2). */
const WhoIsOnWhat = ({ day, people }: { day: string; people: PersonDay[] }) =>
  people.length === 0 ? null : (
    <section className="grid gap-2">
      <h2 className="font-medium">
        Who's on what{" "}
        <span className="font-normal text-muted-foreground">· {day}</span>
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {people.map((p) => (
          <PersonCard key={p.operatorId} person={p} />
        ))}
      </div>
    </section>
  );

/** The ERP sends actual job times: shown instead of the log form. */
const FromErp = ({ at }: { at: Date | null }) => (
  <>
    <Header page="Shop floor" pages={["Schedule"]} />
    <div className="flex flex-1 flex-col gap-3 p-4 pt-0">
      <p className="max-w-3xl text-sm">
        Your ERP sends what each job actually took (the job history report), so
        there's nothing to log here.
        {at
          ? ` Last updated ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}.`
          : " Waiting for its first report."}
      </p>
      <p className="max-w-3xl text-muted-foreground text-sm">
        Takumo compares those times with your routings to keep quotes and the
        schedule accurate. See{" "}
        <Link className="underline" href="/knowledge/calibration">
          how close the estimates are
        </Link>
        .
      </p>
    </div>
  </>
);

const FloorPage = async () => {
  const { orgId, canLogFloor } = await getAccess();
  if (!orgId) {
    notFound();
  }
  // The ERP already records what each job took: nobody types it again here.
  const feeds = await erpFeeds(orgId);
  if ("jobs" in feeds) {
    return <FromErp at={feeds.jobs ?? null} />;
  }
  const db = forOrg(database, orgId);
  const plan = await latestPlan(orgId);
  const assignments = plan?.output.assignments ?? [];
  const crews = byOperation(assignments);
  // Today, or the next day the plan has people on (a weekend, a holiday).
  const day = firstDayFrom(assignments, new Date().toISOString().slice(0, 10));
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
        {day && <WhoIsOnWhat day={day} people={onDay(assignments, day)} />}
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
                  {crews.size > 0 && <TableHead>Who</TableHead>}
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
                    {crews.size > 0 && (
                      <TableCell>
                        {crewNames(
                          crews.get(opKey(op.orderNo, op.seq)) ?? []
                        ) || "—"}
                      </TableCell>
                    )}
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
