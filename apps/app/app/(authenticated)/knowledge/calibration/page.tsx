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
import { factLabel } from "@/lib/facts/attributes";
import { MIN_JOBS, setupTrend, weeklyError } from "@/lib/facts/calibration";
import {
  calibrationStats,
  loadFinishedJobs,
  RECALIBRATION,
} from "@/lib/facts/recalibrate";
import { visibleFactIds } from "@/lib/library/ai-access";
import { resolveViewer } from "@/lib/library/viewer";
import { Header } from "../../components/header";
import { EmptyState } from "../../shop/components/format";
import { ErrorChart } from "./error-chart";
import { RecalibrateButton } from "./recalibrate-button";

export const metadata: Metadata = { title: "Calibration · Takumo" };

/** Weeks of history on the chart. */
const WEEKS = 16;
const DAY_MS = 86_400_000;

const pct = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;

const minutes = (value: number, perPart: boolean) =>
  perPart ? `${value.toFixed(2)} min/part` : `${Math.round(value)} min`;

/** Where an operation stands: a fix waiting, off, or on target. */
const OpStatus = ({
  waiting,
  propose,
  jobs,
}: {
  jobs: number;
  propose: boolean;
  waiting: number | null;
}) => {
  if (waiting !== null) {
    return (
      <Link href={`/knowledge/facts?f=${factLabel(waiting)}`}>
        <Badge variant="secondary">{factLabel(waiting)} to review</Badge>
      </Link>
    );
  }
  if (propose) {
    return <Badge variant="outline">Off: recalibrate</Badge>;
  }
  return (
    <span className="text-muted-foreground text-sm">
      {jobs < MIN_JOBS ? "Needs more jobs" : "On target"}
    </span>
  );
};

const CalibrationPage = async () => {
  const { canReviewFacts } = await getAccess();
  // The same session as getAccess: only facts this person may see.
  const viewer = await resolveViewer();
  if (!viewer) {
    notFound();
  }
  const { orgId } = viewer;
  const now = new Date();
  const db = forOrg(database, orgId);
  const [jobs, stats, lastRun, pending] = await Promise.all([
    loadFinishedJobs(orgId, new Date(now.getTime() - WEEKS * 7 * DAY_MS)),
    calibrationStats(orgId, now),
    db.scheduleRun.findFirst({
      where: { objective: RECALIBRATION },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.fact.findMany({
      where: {
        id: { in: await visibleFactIds(viewer) },
        status: "pending",
        subjectType: "routing",
        attribute: { in: ["setupMin", "runMinPerUnit"] },
      },
      select: { number: true, subjectId: true, attribute: true },
    }),
  ]);
  const weeks = weeklyError(jobs);
  const trend = setupTrend(weeks);
  const pendingFor = (id: string, attribute: string) =>
    pending.find((f) => f.subjectId === id && f.attribute === attribute);
  const rows = [...stats].sort(
    (a, b) =>
      Number(b.propose) - Number(a.propose) ||
      Math.abs(b.median - b.current) / (b.current || 1) -
        Math.abs(a.median - a.current) / (a.current || 1)
  );

  return (
    <>
      <Header page="Calibration" pages={["Knowledge"]}>
        <div className="px-4">
          <RecalibrateButton canRun={canReviewFacts} />
        </div>
      </Header>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          How far the model's times are from what happens on the floor. Every
          finished job is compared with the time the model gave it; each night
          Takumo proposes a correction for any operation that's consistently off
          ({MIN_JOBS}+ jobs), for a supervisor to approve.
          {lastRun &&
            ` Last checked ${lastRun.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`}
        </p>

        {weeks.length === 0 ? (
          <EmptyState>
            No finished jobs yet. Log operations on the{" "}
            <Link className="underline" href="/schedule/floor">
              shop floor
            </Link>{" "}
            or{" "}
            <Link className="underline" href="/onboarding?type=jobs">
              upload your job history
            </Link>
            .
          </EmptyState>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border p-4">
                <p className="text-muted-foreground text-sm">
                  Setup time error, latest week
                </p>
                <p className="mt-1 font-semibold text-2xl">
                  {pct(trend.latest?.setupError ?? null)}
                </p>
                <p className="text-muted-foreground text-xs">
                  {trend.latest
                    ? `${trend.latest.setupJobs} jobs, week of ${trend.latest.week}`
                    : "—"}
                </p>
              </div>
              <div className="rounded-xl border p-4">
                <p className="text-muted-foreground text-sm">Week over week</p>
                <p
                  className={cn(
                    "mt-1 font-semibold text-2xl",
                    trend.dropping === true && "text-emerald-600",
                    trend.dropping === false && "text-amber-600"
                  )}
                >
                  {trend.dropping === null
                    ? "—"
                    : `${trend.dropping ? "↓" : "↑"} ${pct(
                        Math.abs(
                          (trend.latest?.setupError ?? 0) -
                            (trend.previous?.setupError ?? 0)
                        )
                      )}`}
                </p>
                <p className="text-muted-foreground text-xs">
                  {trend.previous
                    ? `vs ${pct(trend.previous.setupError)} the week before`
                    : "Needs two weeks of jobs"}
                  {trend.streak > 1
                    ? ` · down ${trend.streak} weeks in a row`
                    : ""}
                </p>
              </div>
              <div className="rounded-xl border p-4">
                <p className="text-muted-foreground text-sm">
                  Corrections waiting
                </p>
                <p className="mt-1 font-semibold text-2xl">{pending.length}</p>
                <p className="text-muted-foreground text-xs">
                  <Link className="underline" href="/knowledge/facts">
                    Review them
                  </Link>{" "}
                  to bring the error down
                </p>
              </div>
            </div>
            <div className="rounded-xl border p-3">
              <p className="mb-2 font-medium text-sm">
                Mean absolute error of planned vs actual time, by week finished
              </p>
              <ErrorChart weeks={weeks} />
            </div>
          </>
        )}

        {rows.length > 0 && (
          <>
            <h2 className="font-medium">
              Operations: routing vs actual (last 120 days)
            </h2>
            <div className="rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Operation</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead className="text-right">Routing</TableHead>
                    <TableHead className="text-right">
                      Actual (median)
                    </TableHead>
                    <TableHead className="text-right">Range</TableHead>
                    <TableHead className="text-right">Jobs</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => {
                    const perPart = s.attribute === "runMinPerUnit";
                    const waiting = pendingFor(s.op.id, s.attribute);
                    const off = s.current
                      ? (s.median - s.current) / s.current
                      : 0;
                    return (
                      <TableRow key={`${s.op.id}-${s.attribute}`}>
                        <TableCell className="font-medium">
                          {s.op.label}
                        </TableCell>
                        <TableCell>{perPart ? "Run" : "Setup"}</TableCell>
                        <TableCell className="text-right">
                          {minutes(s.current, perPart)}
                        </TableCell>
                        <TableCell className="text-right">
                          {minutes(s.median, perPart)}
                          <span
                            className={cn(
                              "ml-1 text-xs",
                              Math.abs(off) >= 0.1
                                ? "text-amber-600"
                                : "text-muted-foreground"
                            )}
                          >
                            {off >= 0 ? "+" : ""}
                            {Math.round(off * 100)}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {perPart
                            ? `${s.min.toFixed(2)}–${s.max.toFixed(2)}`
                            : `${Math.round(s.min)}–${Math.round(s.max)}`}
                        </TableCell>
                        <TableCell className="text-right">
                          {s.jobs.length}
                        </TableCell>
                        <TableCell>
                          <OpStatus
                            jobs={s.jobs.length}
                            propose={s.propose}
                            waiting={waiting?.number ?? null}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>
    </>
  );
};

export default CalibrationPage;
