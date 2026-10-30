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
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { Header } from "../../components/header";
import { EmptyState } from "../../shop/components/format";
import { fmtDay } from "../gantt";
import { CalendarForm, RemoveDays } from "./calendar-form";

export const metadata: Metadata = { title: "Shop calendar · Takumo" };

const CalendarPage = async () => {
  const { orgId, canEditShop } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const db = forOrg(database, orgId);
  const today = new Date(new Date().toISOString().slice(0, 10));
  const [machines, days] = await Promise.all([
    db.workCenter.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.calendarDay.findMany({
      where: { date: { gte: new Date(today.getTime() - 86_400_000) } },
      orderBy: [{ date: "asc" }],
      select: {
        id: true,
        date: true,
        availableHours: true,
        reason: true,
        workCenter: { select: { name: true } },
      },
    }),
  ]);

  // One row per date + hours + reason, listing the machines it applies to.
  const groups = new Map<
    string,
    {
      date: string;
      hours: number;
      reason: string | null;
      machines: string[];
      ids: string[];
    }
  >();
  for (const day of days) {
    const date = day.date.toISOString().slice(0, 10);
    const key = `${date}|${day.availableHours}|${day.reason ?? ""}`;
    const group = groups.get(key) ?? {
      date,
      hours: day.availableHours,
      reason: day.reason,
      machines: [],
      ids: [],
    };
    group.machines.push(day.workCenter.name);
    group.ids.push(day.id);
    groups.set(key, group);
  }

  return (
    <>
      <Header page="Calendar" pages={["Schedule"]} />
      <div className="flex min-w-0 flex-1 flex-col gap-6 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          Machines run their normal hours Monday to Friday. Add holidays,
          maintenance or extra shifts here; the scheduler plans around them.
        </p>
        {canEditShop && <CalendarForm machines={machines} />}
        {groups.size === 0 ? (
          <EmptyState>No holidays or downtime coming up.</EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Machines</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead>Reason</TableHead>
                  {canEditShop && <TableHead className="w-12" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...groups.values()].map((g) => (
                  <TableRow key={`${g.date}-${g.ids[0]}`}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {fmtDay(g.date, "long")}
                    </TableCell>
                    <TableCell>
                      {g.machines.length === machines.length
                        ? "All machines"
                        : g.machines.join(", ")}
                    </TableCell>
                    <TableCell>
                      {g.hours === 0 ? "Closed" : `${g.hours} h`}
                    </TableCell>
                    <TableCell>{g.reason ?? "—"}</TableCell>
                    {canEditShop && (
                      <TableCell>
                        <RemoveDays
                          ids={g.ids}
                          label={`Remove ${g.date}${g.reason ? ` (${g.reason})` : ""}`}
                        />
                      </TableCell>
                    )}
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

export default CalendarPage;
