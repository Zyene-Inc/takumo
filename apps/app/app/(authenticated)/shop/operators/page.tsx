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
import { formatDays, formatShift, readShift } from "@repo/ingest";
import { PencilIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { erpFeeds } from "@/lib/erp/feeds";
import { shortDay } from "@/lib/schedule/material";
import { Header } from "../../components/header";
import { DeleteButton } from "../components/delete-button";
import { ErpFeedNote } from "../components/erp-feed-note";
import {
  EmptyState,
  ErpBadge,
  FilterNote,
  formValue,
  isoDate,
  textFilter,
} from "../components/format";
import { RecordDialog } from "../components/record-dialog";
import { TimeOffChip, TimeOffDialog } from "./time-off";

export const metadata: Metadata = { title: "Operators · Takumo" };

/** Upcoming time off shown per person; the rest is counted. */
const SHOWN_DAYS_OFF = 3;

type OperatorWithDays = Awaited<
  ReturnType<ReturnType<typeof forOrg>["operator"]["findMany"]>
>[number] & {
  days: { date: Date; hours: number; id: string; reason: string | null }[];
};

/** Upcoming days off, as chips; the rest counted. */
const DaysOff = ({
  canEdit,
  days,
}: {
  canEdit: boolean;
  days: OperatorWithDays["days"];
}) => (
  <div className="flex flex-wrap gap-1">
    {days.slice(0, SHOWN_DAYS_OFF).map((d) => (
      <TimeOffChip
        canEdit={canEdit}
        id={d.id}
        key={d.id}
        label={`${shortDay(isoDate(d.date))}${d.hours > 0 ? ` (${d.hours} h)` : ""}${d.reason ? ` · ${d.reason}` : ""}`}
      />
    ))}
    {days.length > SHOWN_DAYS_OFF && (
      <span className="text-muted-foreground text-xs">
        +{days.length - SHOWN_DAYS_OFF} more
      </span>
    )}
    {days.length === 0 && (
      <span className="text-muted-foreground text-xs">—</span>
    )}
  </div>
);

/** One person on the roster: shift, machines, time off, and edits. */
const OperatorRow = ({
  operator: o,
  canEdit,
  machineName,
  machineNames,
}: {
  canEdit: boolean;
  machineName: Map<string, string>;
  machineNames: string[];
  operator: OperatorWithDays;
}) => {
  const shift = readShift(o.shifts);
  const runs = o.workCenterIds
    .map((id) => machineName.get(id))
    .filter((n): n is string => Boolean(n));
  return (
    <TableRow className={o.active ? undefined : "opacity-60"} key={o.id}>
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          {o.name}
          <ErpBadge syncedAt={o.syncedAt} />
          {!o.active && (
            <span className="rounded bg-muted px-1.5 text-muted-foreground text-xs">
              inactive
            </span>
          )}
        </div>
        {o.externalId && (
          <span className="text-muted-foreground text-xs">#{o.externalId}</span>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {shift ? formatShift(shift) : "Any time"}
        {o.canRunUnattended && (
          <span className="block text-muted-foreground text-xs">
            can leave machines running
          </span>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {runs.length ? (
          runs.join(", ")
        ) : (
          <span className="text-amber-700 dark:text-amber-400">
            None listed
          </span>
        )}
      </TableCell>
      <TableCell>
        <DaysOff canEdit={canEdit} days={o.days} />
      </TableCell>
      <TableCell>
        <div className="flex justify-end">
          {canEdit && <TimeOffDialog name={o.name} operatorId={o.id} />}
          <RecordDialog
            canEdit={canEdit && !o.syncedAt}
            entity="operators"
            initial={{
              name: o.name,
              employeeId: formValue(o.externalId),
              active: o.active ? "yes" : "no",
              shiftStart: shift?.start ?? "",
              shiftEnd: shift?.end ?? "",
              shiftDays: shift ? formatDays(shift.days) : "",
              unattended: o.canRunUnattended ? "yes" : "no",
              skills: runs.join(", "),
              hourlyRate: formValue(o.hourlyRate),
            }}
            locked={["name"]}
            options={{ skills: machineNames }}
            title={`Edit ${o.name}`}
            trigger={
              <Button aria-label={`Edit ${o.name}`} size="icon" variant="ghost">
                <PencilIcon />
              </Button>
            }
          />
          <DeleteButton
            canEdit={canEdit && !o.syncedAt}
            entity="operators"
            id={o.id}
            name={o.name}
          />
        </div>
      </TableCell>
    </TableRow>
  );
};

const OperatorsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) => {
  const { orgId, canEditShop } = await getAccess();
  if (!orgId) {
    notFound();
  }
  // People the ERP sends are added there, not typed in here.
  const feeds = await erpFeeds(orgId);
  const erpFed = "operators" in feeds;
  const q = textFilter((await searchParams).q);
  const today = new Date(`${isoDate(new Date())}T00:00:00Z`);
  const db = forOrg(database, orgId);
  const [operators, machines] = await Promise.all([
    db.operator.findMany({
      where: q ? { name: { contains: q, mode: "insensitive" } } : {},
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: {
        days: {
          where: { date: { gte: today } },
          orderBy: { date: "asc" },
        },
      },
    }),
    db.workCenter.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, unattendedRuns: true },
    }),
  ]);
  const machineName = new Map(machines.map((m) => [m.id, m.name]));
  const machineNames = machines.map((m) => m.name);
  const active = operators.filter((o) => o.active);
  // Who can run each machine (F3.1-R5): nobody means its hours aren't
  // backed by people.
  const coverage = machines.map((m) => ({
    ...m,
    people: active.filter((o) => o.workCenterIds.includes(m.id)),
  }));
  const uncovered = active.length
    ? coverage.filter((m) => m.people.length === 0)
    : [];

  return (
    <>
      <Header page="Operators" pages={["Shop"]}>
        <div className="px-4">
          {erpFed ? (
            <ErpFeedNote at={feeds.operators} />
          ) : (
            <RecordDialog
              canEdit={canEditShop}
              entity="operators"
              initial={{ active: "yes", shiftDays: "Mon-Fri" }}
              options={{ skills: machineNames }}
              title="Add an operator"
              trigger={
                <Button size="sm">
                  <PlusIcon /> Add operator
                </Button>
              }
            />
          )}
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          Machines don't run without people. Takumo plans each machine only for
          the hours someone qualified on it is in, so "can we ship by Friday?"
          counts shifts, skills and time off.
        </p>
        {q && <FilterNote href="/shop/operators" q={q} />}
        {uncovered.length > 0 && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
            <p className="font-medium">
              Nobody is listed to run {uncovered.map((m) => m.name).join(", ")}.
            </p>
            <p className="mt-1 text-muted-foreground">
              Their hours aren't checked against people until someone qualified
              is added below (Machines column).
            </p>
          </div>
        )}
        {operators.length === 0 ? (
          <EmptyState>
            No operators yet.{" "}
            <Link className="underline" href="/onboarding?type=operators">
              Upload your roster
            </Link>{" "}
            (or have your ERP email its employee report), or add them one by
            one. Until then, machines are planned for their full hours.
          </EmptyState>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Shift</TableHead>
                  <TableHead>Machines</TableHead>
                  <TableHead>Time off</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {operators.map((o) => (
                  <OperatorRow
                    canEdit={canEditShop}
                    key={o.id}
                    machineName={machineName}
                    machineNames={machineNames}
                    operator={o}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {active.length > 0 && machines.length > 0 && (
          <section className="grid gap-2">
            <h2 className="font-medium">Who can run each machine</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {coverage.map((m) => (
                <div className="rounded-xl border p-3 text-sm" key={m.id}>
                  <p className="font-medium">
                    {m.name}
                    {m.unattendedRuns && (
                      <span className="ml-2 text-muted-foreground text-xs">
                        lights-out
                      </span>
                    )}
                  </p>
                  {m.people.length ? (
                    <ul className="mt-1 text-muted-foreground">
                      {m.people.map((p) => {
                        const shift = readShift(p.shifts);
                        return (
                          <li key={p.id}>
                            {p.name}
                            {shift ? ` · ${formatShift(shift)}` : ""}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="mt-1 text-amber-700 dark:text-amber-400">
                      Nobody listed: hours not checked against people.
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
};

export default OperatorsPage;
