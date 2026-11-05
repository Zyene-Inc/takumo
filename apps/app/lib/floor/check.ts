// What a shop-floor log must hold. Pure, so tested.

export interface OperationLog {
  /** When the operation finished (defaults to now). */
  finishedAt?: Date;
  orderId: string;
  qtyGood: number;
  qtyScrap: number;
  runMin: number;
  seq: number;
  setupMin: number;
  /** Defaults to the finish minus setup and run time. */
  startedAt?: Date;
  /** The machine it ran on (defaults to the planned one, else the routing's). */
  workCenterId?: string | null;
}

const MAX_LOG_MINUTES = 100_000;

export const checkLog = (
  log: OperationLog,
  now = new Date()
): string | null => {
  const minutes = [log.setupMin, log.runMin];
  if (
    minutes.some((m) => !Number.isFinite(m) || m < 0 || m > MAX_LOG_MINUTES)
  ) {
    return "Setup and run time are minutes, 0 or more.";
  }
  const qtys = [log.qtyGood, log.qtyScrap];
  if (qtys.some((q) => !Number.isInteger(q) || q < 0)) {
    return "Quantities are whole numbers, 0 or more.";
  }
  if (log.qtyGood + log.qtyScrap === 0) {
    return "Enter how many parts were made.";
  }
  if (log.finishedAt && log.finishedAt.getTime() > now.getTime() + 3_600_000) {
    return "The finish time is in the future.";
  }
  const finished = log.finishedAt ?? now;
  if (log.startedAt && log.startedAt.getTime() > finished.getTime()) {
    return "The start time is after the finish.";
  }
  return null;
};
