// When each person's brief goes out (docs/PRODUCT-PLAN.md F4.1-R1): at the
// local time they chose (06:30 unless they changed it), Monday to Friday,
// once a day. The cron runs every 15 minutes; a brief is due from its time
// for the next two hours (a missed run catches up, a day-old one doesn't).
// Pure, so tested.

const DEFAULT_BRIEF_TIME = "06:30";
const DEFAULT_TIME_ZONE = "America/Chicago";
const CATCH_UP_MIN = 120;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isClock = (value: string) => CLOCK.test(value);

export const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

interface LocalNow {
  /** YYYY-MM-DD in that zone. */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
  /** 1 = Monday … 7 = Sunday. */
  weekday: number;
}

const WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export const localNow = (zone: string, now: Date): LocalNow => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAY[parts.weekday] ?? 1,
  };
};

export interface BriefTiming {
  briefOn: boolean;
  briefTime: string;
  lastBriefOn: string | null;
  timeZone: string;
}

export const DEFAULT_TIMING: BriefTiming = {
  briefOn: true,
  briefTime: DEFAULT_BRIEF_TIME,
  lastBriefOn: null,
  timeZone: DEFAULT_TIME_ZONE,
};

/** Whether this person's brief is due now; `date` is their local day. */
export const briefDue = (
  timing: BriefTiming,
  now: Date
): { due: boolean; date: string } => {
  const local = localNow(timing.timeZone, now);
  if (!timing.briefOn || local.weekday > 5) {
    return { due: false, date: local.date };
  }
  if (timing.lastBriefOn === local.date) {
    return { due: false, date: local.date };
  }
  const [h, m] = (
    isClock(timing.briefTime) ? timing.briefTime : DEFAULT_BRIEF_TIME
  )
    .split(":")
    .map(Number);
  const at = h * 60 + m;
  return {
    due: local.minutes >= at && local.minutes < at + CATCH_UP_MIN,
    date: local.date,
  };
};
