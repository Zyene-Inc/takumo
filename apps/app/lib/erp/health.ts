// Which ERP reports have stopped arriving (docs/PRODUCT-PLAN.md F1.6): a
// nightly report that hasn't come for over a day means the ERP's schedule or
// a mail rule broke, and Takumo's data is going stale. Pure, so tested.

const HOUR = 3_600_000;
/** A nightly report is late after this long (a day, plus slack for retries). */
export const LATE_AFTER_HOURS = 26;

export interface ReportHealth {
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
    // A report confirmed just now hasn't had its first night yet.
    const since = r.lastReceivedAt ?? r.updatedAt;
    return now.getTime() - since.getTime() > LATE_AFTER_HOURS * HOUR;
  });

const ago = (from: Date | null, now: Date) => {
  if (!from) {
    return "never received";
  }
  const days = Math.floor((now.getTime() - from.getTime()) / (24 * HOUR));
  return days <= 1
    ? "last received yesterday"
    : `last received ${days} days ago`;
};

/** The lines of the email to a shop's admins. */
export const healthLines = (
  late: ReportHealth[],
  brokenMailboxes: string[],
  now: Date
) => [
  ...late.map(
    (r) =>
      `• ${r.name}: ${ago(r.lastReceivedAt, now)}. Check the ERP's scheduled report or the mail rule that sends it.`
  ),
  ...brokenMailboxes.map(
    (m) => `• ${m}: the connection stopped working. Reconnect it.`
  ),
];
