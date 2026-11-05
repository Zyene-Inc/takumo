// How far the model's times are from what happens on the floor, and what to
// change. Pure, so tested.
//
// - weeklyError: for jobs finished each week, the mean absolute percentage
//   error between the time the model gave the job (planned) and the actual
//   time. Phase 5 is done when the setup-time error drops week over week.
// - proposals: for each operation with enough recent jobs, the median actual
//   time, proposed as a fact when it's well off the routing. Only jobs
//   finished after the routing's value last changed count, so an approved
//   correction isn't proposed again from older jobs.

export const MIN_JOBS = 3;
export const LOOKBACK_DAYS = 120;
/** Propose a change when the median is this far off (both must hold). */
const SETUP_THRESHOLD = { relative: 0.15, minutes: 5 };
const RUN_THRESHOLD = { relative: 0.1, minutes: 0.05 };

const DAY_MS = 86_400_000;

export interface FinishedJob {
  actualEnd: Date;
  actualRunMin: number | null;
  actualSetupMin: number | null;
  orderNo: string;
  plannedRunMinPerUnit: number | null;
  plannedSetupMin: number | null;
  qty: number;
  routingId: string | null;
}

export interface WeekError {
  jobs: number;
  /** Mean absolute % error of run time per part (null: no comparable jobs). */
  runError: number | null;
  runJobs: number;
  setupError: number | null;
  setupJobs: number;
  /** Monday of the week, YYYY-MM-DD (UTC). */
  week: string;
}

/** Monday of the week a date falls in, YYYY-MM-DD. */
export const weekOf = (date: Date) => {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
};

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round = (value: number, places: number) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

const runPerUnit = (job: FinishedJob) =>
  job.actualRunMin !== null && job.qty > 0 ? job.actualRunMin / job.qty : null;

export const weeklyError = (jobs: FinishedJob[]): WeekError[] => {
  const weeks = new Map<string, FinishedJob[]>();
  for (const job of jobs) {
    const key = weekOf(job.actualEnd);
    weeks.set(key, [...(weeks.get(key) ?? []), job]);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, list]) => {
      const setup = list.flatMap((j) =>
        j.actualSetupMin && j.actualSetupMin > 0 && j.plannedSetupMin !== null
          ? [Math.abs(j.actualSetupMin - j.plannedSetupMin) / j.actualSetupMin]
          : []
      );
      const run = list.flatMap((j) => {
        const actual = runPerUnit(j);
        return actual && actual > 0 && j.plannedRunMinPerUnit !== null
          ? [Math.abs(actual - j.plannedRunMinPerUnit) / actual]
          : [];
      });
      const setupError = mean(setup);
      const runError = mean(run);
      return {
        week,
        jobs: list.length,
        setupJobs: setup.length,
        runJobs: run.length,
        setupError: setupError === null ? null : round(setupError, 4),
        runError: runError === null ? null : round(runError, 4),
      };
    });
};

interface Trend {
  /** The latest week's setup error is below the week before. */
  dropping: boolean | null;
  latest: WeekError | null;
  previous: WeekError | null;
  /** Weeks in a row, ending with the latest, where the error fell. */
  streak: number;
}

/** How setup-time error moved over the weeks that have measurements. */
export const setupTrend = (weeks: WeekError[]): Trend => {
  const measured = weeks.filter((w) => w.setupError !== null);
  const latest = measured.at(-1) ?? null;
  const previous = measured.at(-2) ?? null;
  let streak = 0;
  for (let i = measured.length - 1; i > 0; i -= 1) {
    if ((measured[i].setupError ?? 0) < (measured[i - 1].setupError ?? 0)) {
      streak += 1;
    } else {
      break;
    }
  }
  return {
    latest,
    previous,
    streak,
    dropping:
      latest && previous
        ? (latest.setupError ?? 0) < (previous.setupError ?? 0)
        : null,
  };
};

export interface CalibratedOp {
  id: string;
  label: string;
  runMinPerUnit: number;
  /** When each value last changed (an approved fact), if ever. */
  runSince: Date | null;
  setupMin: number;
  setupSince: Date | null;
}

interface OpStats {
  attribute: "setupMin" | "runMinPerUnit";
  current: number;
  jobs: FinishedJob[];
  max: number;
  /** Median actual minutes (per part for run time). */
  median: number;
  min: number;
  op: CalibratedOp;
  /** Off by enough to propose a change. */
  propose: boolean;
  /** Rounded median, the value to propose. */
  value: number;
}

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** Actual times per operation, compared with the routing. */
export const operationStats = (
  ops: CalibratedOp[],
  jobs: FinishedJob[],
  now: Date
): OpStats[] => {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const stats: OpStats[] = [];
  for (const op of ops) {
    const mine = jobs.filter(
      (j) => j.routingId === op.id && j.actualEnd >= since
    );
    const setupJobs = mine.filter(
      (j) =>
        j.actualSetupMin !== null &&
        (!op.setupSince || j.actualEnd > op.setupSince)
    );
    const runJobs = mine.filter(
      (j) =>
        runPerUnit(j) !== null && (!op.runSince || j.actualEnd > op.runSince)
    );
    const series: [
      OpStats["attribute"],
      FinishedJob[],
      (j: FinishedJob) => number,
      number,
      typeof SETUP_THRESHOLD,
      number,
    ][] = [
      [
        "setupMin",
        setupJobs,
        (j) => j.actualSetupMin ?? 0,
        op.setupMin,
        SETUP_THRESHOLD,
        0,
      ],
      [
        "runMinPerUnit",
        runJobs,
        (j) => runPerUnit(j) ?? 0,
        op.runMinPerUnit,
        RUN_THRESHOLD,
        2,
      ],
    ];
    for (const [attribute, list, value, current, threshold, places] of series) {
      if (list.length === 0) {
        continue;
      }
      const values = list.map(value);
      const m = median(values);
      const diff = Math.abs(m - current);
      stats.push({
        op,
        attribute,
        current,
        jobs: list,
        median: m,
        min: Math.min(...values),
        max: Math.max(...values),
        value: round(m, places),
        propose:
          list.length >= MIN_JOBS &&
          diff >= threshold.minutes &&
          (current === 0 || diff / current >= threshold.relative) &&
          round(m, places) !== current,
      });
    }
  }
  return stats;
};

/** Why Takumo proposes the change, for the reviewer. */
export const evidenceFor = (s: OpStats) => {
  const unit = s.attribute === "setupMin" ? "min setup" : "min/part run";
  const fmt = (n: number) => round(n, s.attribute === "setupMin" ? 0 : 2);
  const dates = s.jobs.map((j) => j.actualEnd.getTime());
  const orders = [...new Set(s.jobs.map((j) => j.orderNo))];
  return `Median of ${s.jobs.length} jobs finished ${DATE.format(Math.min(...dates))} – ${DATE.format(Math.max(...dates))}: ${fmt(s.median)} ${unit} (range ${fmt(s.min)}–${fmt(s.max)}), vs ${s.current} in the routing. Orders: ${orders.slice(0, 8).join(", ")}${orders.length > 8 ? ` and ${orders.length - 8} more` : ""}.`;
};
