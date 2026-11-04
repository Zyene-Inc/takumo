// Which ERP reports have stopped arriving (docs/PRODUCT-PLAN.md F1.6): a
// nightly report that hasn't come for over a day means the ERP's schedule or
// a mail rule broke, and Takumo's data is going stale. Pure, so tested.

const HOUR = 3_600_000;
/** A nightly report is late after this long (a day, plus slack for retries). */
export const LATE_AFTER_HOURS = 26;

export interface ReportHealth {
  /** Last import that saved rows; a report that arrives but fails is late too. */
  lastImportAt: Date | null;
  lastReceivedAt: Date | null;
  name: string;
  status: string;
  updatedAt: Date;
}

/** Active reports that should have arrived by now and haven't. */
export const lateReports = <T extends ReportHealth>(reports: T[], now: Date) =>
  reports.filter((r) => {
    if (r.status !== "active") {
      return false;
    }
    // Counted from the last good import: a report that keeps arriving but
    // can't be read (a renamed column) is as stale as one that stopped.
    // A report confirmed just now hasn't had its first night yet.
    const since = r.lastImportAt ?? r.updatedAt;
    return now.getTime() - since.getTime() > LATE_AFTER_HOURS * HOUR;
  });

const daysAgo = (from: Date, now: Date) => {
  const days = Math.floor((now.getTime() - from.getTime()) / (24 * HOUR));
  return days <= 1 ? "yesterday" : `${days} days ago`;
};

/** What went wrong with a late report, and what to check. */
const lateLine = (r: ReportHealth, now: Date) => {
  const arriving =
    r.lastReceivedAt &&
    (!r.lastImportAt || r.lastReceivedAt > r.lastImportAt) &&
    now.getTime() - r.lastReceivedAt.getTime() <= LATE_AFTER_HOURS * HOUR;
  if (arriving) {
    return `• ${r.name}: it arrives but hasn't imported since ${r.lastImportAt ? daysAgo(r.lastImportAt, now) : "it was set up"}. A column may have been renamed in your ERP: check this report's columns.`;
  }
  const last = r.lastReceivedAt
    ? `last received ${daysAgo(r.lastReceivedAt, now)}`
    : "never received";
  return `• ${r.name}: ${last}. Check the ERP's scheduled report or the mail rule that sends it.`;
};

/** The lines of the email to a shop's admins. */
export const healthLines = (
  late: ReportHealth[],
  brokenMailboxes: string[],
  now: Date
) => [
  ...late.map((r) => lateLine(r, now)),
  ...brokenMailboxes.map(
    (m) => `• ${m}: the connection stopped working. Reconnect it.`
  ),
];
