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
import { cn } from "@repo/design-system/lib/utils";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { latestPlan } from "@/lib/schedule/plan";
import { Header } from "../../components/header";
import { EmptyState } from "../../shop/components/format";
import { addDays, fmtDay, fmtHours, hoursOn } from "../gantt";

export const metadata: Metadata = { title: "Bottlenecks · Takumo" };

const WINDOWS = [
  { days: 7, label: "Next 7 days" },
  { days: 14, label: "Next 2 weeks" },
  { days: 28, label: "Next 4 weeks" },
];

const pct = (load: number, capacity: number) =>
  capacity === 0 ? 0 : Math.round((load / capacity) * 100);

const Bar = ({ value }: { value: number }) => (
  <div className="flex items-center gap-2">
    <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full",
          "bg-primary",
          value >= 75 && "bg-amber-500",
          value >= 90 && "bg-destructive"
        )}
        style={{ width: `${Math.min(100, value)}%` }}
      />
    </div>
    <span className="w-10 text-right tabular-nums">{value}%</span>
  </div>
);

const BottlenecksPage = async () => {
  const { orgId } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const plan = await latestPlan(orgId);

  if (!plan) {
    return (
      <>
        <Header page="Bottlenecks" pages={["Schedule"]} />
        <div className="p-4 pt-0">
          <EmptyState>
            No plan yet.{" "}
            <Link className="underline" href="/schedule">
              Build one on the schedule board
            </Link>
            .
          </EmptyState>
        </div>
      </>
    );
  }

  const { request } = plan.input;
  const start = request.start_date;
  const machines = request.work_centers.map((wc) => {
    const days = plan.output.load.filter((d) => d.work_center === wc.name);
    const windows = WINDOWS.map((w) => {
      const end = addDays(start, w.days);
      const load = days
        .filter((d) => d.date < end)
        .reduce((sum, d) => sum + d.load_minutes, 0);
      // Capacity over the whole window, even past the plan's last operation.
      let capacity = 0;
      for (let i = 0; i < w.days; i += 1) {
        capacity += Math.round(
          hoursOn(wc, addDays(start, i)) * 60 * (wc.efficiency ?? 1)
        );
      }
      return { load, capacity, pct: pct(load, capacity) };
    });
    const busiest = [...days]
      .filter((d) => d.capacity_minutes > 0)
      .sort(
        (a, b) =>
          b.load_minutes / b.capacity_minutes -
          a.load_minutes / a.capacity_minutes
      )[0];
    const totalLoad = days.reduce((sum, d) => sum + d.load_minutes, 0);
    return { name: wc.name, rate: wc.hourly_rate, windows, busiest, totalLoad };
  });
  const ranked = [...machines].sort(
    (a, b) => b.windows[1].pct - a.windows[1].pct
  );
  const bottleneck = ranked[0];

  // Which machine each late order's last operation runs on.
  const lastOps = new Map<string, string>();
  for (const op of [...plan.output.operations].sort((a, b) =>
    a.end_at.localeCompare(b.end_at)
  )) {
    lastOps.set(op.order_no, op.work_center);
  }
  const late = plan.output.orders
    .filter((o) => o.days_late > 0)
    .sort((a, b) => b.days_late - a.days_late);
  const db = forOrg(database, orgId);
  const customers = new Map(
    (
      await db.order.findMany({
        where: { orderNo: { in: late.map((o) => o.order_no) } },
        select: { orderNo: true, customer: { select: { name: true } } },
      })
    ).map((o) => [o.orderNo, o.customer?.name ?? null])
  );

  return (
    <>
      <Header page="Bottlenecks" pages={["Schedule"]} />
      <div className="flex min-w-0 flex-1 flex-col gap-6 p-4 pt-0">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl bg-muted/50 p-5">
            <p className="text-muted-foreground text-sm">
              Bottleneck, next 2 weeks
            </p>
            <p className="font-semibold text-2xl">{bottleneck?.name ?? "—"}</p>
            {bottleneck && (
              <p className="text-muted-foreground text-sm">
                {bottleneck.windows[1].pct}% of its hours booked
              </p>
            )}
          </div>
          <div className="rounded-xl bg-muted/50 p-5">
            <p className="text-muted-foreground text-sm">Late orders</p>
            <p className="font-semibold text-2xl">
              {late.length} of {plan.output.orders.length}
            </p>
            <p className="text-muted-foreground text-sm">
              {plan.output.total_days_late} days late in total
            </p>
          </div>
          <div className="rounded-xl bg-muted/50 p-5">
            <p className="text-muted-foreground text-sm">Plan</p>
            <p className="font-semibold text-2xl">from {fmtDay(start)}</p>
            <p className="text-muted-foreground text-sm">
              <Link className="underline" href="/schedule">
                Open the board
              </Link>
            </p>
          </div>
        </div>

        <section className="grid gap-2">
          <h2 className="font-semibold">Machine load</h2>
          <p className="text-muted-foreground text-sm">
            Planned hours as a share of the hours each machine runs (after
            efficiency, holidays and downtime).
          </p>
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Machine</TableHead>
                  {WINDOWS.map((w) => (
                    <TableHead key={w.days}>{w.label}</TableHead>
                  ))}
                  <TableHead>Busiest day</TableHead>
                  <TableHead className="text-right">Planned</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ranked.map((m) => (
                  <TableRow key={m.name}>
                    <TableCell className="font-medium">
                      {m.name}
                      {m === bottleneck && m.windows[1].pct > 0 && (
                        <Badge className="ml-2" variant="outline">
                          Bottleneck
                        </Badge>
                      )}
                    </TableCell>
                    {m.windows.map((w, i) => (
                      <TableCell key={WINDOWS[i].days}>
                        <Bar value={w.pct} />
                      </TableCell>
                    ))}
                    <TableCell className="whitespace-nowrap">
                      {m.busiest && m.busiest.load_minutes > 0
                        ? `${fmtDay(m.busiest.date)} (${pct(m.busiest.load_minutes, m.busiest.capacity_minutes)}%)`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtHours(m.totalLoad)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <section className="grid gap-2">
          <h2 className="font-semibold">Late orders</h2>
          {late.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Every order in the plan ships on time.
            </p>
          ) : (
            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Finishes</TableHead>
                    <TableHead className="text-right">Days late</TableHead>
                    <TableHead>Last machine</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {late.map((o) => (
                    <TableRow key={o.order_no}>
                      <TableCell className="font-medium">
                        {o.order_no}
                      </TableCell>
                      <TableCell>{customers.get(o.order_no) ?? "—"}</TableCell>
                      <TableCell>{fmtDay(o.due_date)}</TableCell>
                      <TableCell>{fmtDay(o.completion_date)}</TableCell>
                      <TableCell className="text-right text-destructive">
                        {o.days_late}
                      </TableCell>
                      <TableCell>{lastOps.get(o.order_no) ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>
    </>
  );
};

export default BottlenecksPage;
