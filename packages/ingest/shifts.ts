// Shift times and days as people and ERP exports write them ("3:30 PM",
// "Mon-Fri", "M,W,F"), read into one shape: { start, end, days } with 24-hour
// "HH:MM" clock times and ISO weekdays (1 = Monday … 7 = Sunday), the same
// days WorkCenter.shifts uses. Pure, so tested.

export interface Shift {
  /** ISO weekdays, 1 = Monday. */
  days: number[];
  /** "HH:MM"; at or before `start` means it runs past midnight. */
  end: string;
  start: string;
}

export const WEEKDAYS = [1, 2, 3, 4, 5];

const CLOCK = /^(\d{1,2})(?::?(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i;

/** "7", "07:00", "3:30 PM", "1530", "24:00" → "HH:MM"; null when unreadable. */
export const parseClock = (text: string): string | null => {
  const m = text.trim().match(CLOCK);
  if (!m) {
    return null;
  }
  let hours = Number(m[1]);
  const minutes = Number(m[2] ?? 0);
  const meridiem = m[3]?.toLowerCase().replace(/\./g, "");
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes > 0)) {
    return null;
  }
  if (meridiem) {
    if (hours < 1 || hours > 12) {
      return null;
    }
    hours = (hours % 12) + (meridiem === "pm" ? 12 : 0);
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

const DAY_NAMES: Record<string, number> = {
  m: 1,
  mo: 1,
  mon: 1,
  monday: 1,
  t: 2,
  tu: 2,
  tue: 2,
  tues: 2,
  tuesday: 2,
  w: 3,
  we: 3,
  wed: 3,
  wednesday: 3,
  th: 4,
  r: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  f: 5,
  fr: 5,
  fri: 5,
  friday: 5,
  sa: 6,
  sat: 6,
  saturday: 6,
  su: 7,
  sun: 7,
  sunday: 7,
};

const RANGE = /^(\w+)\s*(?:-|–|to|through|thru)\s*(\w+)$/i;
const LIST_SEPARATOR = /[,/;&]|\band\b/;
const ALL_WEEK = new Set(["daily", "every day", "7 days"]);

/** "Fri-Mon" → Fri, Sat, Sun, Mon; null when a name can't be read. */
const dayRange = (from: string, to: string) => {
  const first = DAY_NAMES[from];
  const last = DAY_NAMES[to];
  if (!(first && last)) {
    return null;
  }
  const days: number[] = [];
  for (let d = first; ; d = (d % 7) + 1) {
    days.push(d);
    if (d === last) {
      return days;
    }
  }
};

/** One item of a list: a range or a single day. */
const dayItem = (item: string) => {
  const range = item.match(RANGE);
  if (range) {
    return dayRange(range[1] as string, range[2] as string);
  }
  const day = DAY_NAMES[item];
  return day ? [day] : null;
};

/**
 * "Mon-Fri", "M-F", "Mon, Wed, Fri", "Tue-Sat", "weekdays", "Sat" → ISO
 * weekdays, sorted; null when a part can't be read (never a guess).
 */
export const parseDays = (text: string): number[] | null => {
  const clean = text.trim().toLowerCase();
  if (!clean) {
    return null;
  }
  if (clean === "weekdays") {
    return [...WEEKDAYS];
  }
  if (ALL_WEEK.has(clean)) {
    return [1, 2, 3, 4, 5, 6, 7];
  }
  const days = new Set<number>();
  for (const part of clean.split(LIST_SEPARATOR)) {
    const item = part.trim();
    if (!item) {
      continue;
    }
    const found = dayItem(item);
    if (!found) {
      return null;
    }
    for (const d of found) {
      days.add(d);
    }
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
};

/** Hours a shift lasts ("15:30"–"24:00" = 8.5; overnight wraps). */
export const shiftHours = (shift: Pick<Shift, "end" | "start">) => {
  const minutes = (clock: string) => {
    const [h, m] = clock.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const length = minutes(shift.end) - minutes(shift.start);
  return (length > 0 ? length : length + 24 * 60) / 60;
};

/** A stored shift (Operator.shifts), or null when it isn't one. */
export const readShift = (value: unknown): Shift | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v = value as { days?: unknown; end?: unknown; start?: unknown };
  const start = typeof v.start === "string" ? parseClock(v.start) : null;
  const end = typeof v.end === "string" ? parseClock(v.end) : null;
  if (!(start && end)) {
    return null;
  }
  const days = Array.isArray(v.days)
    ? v.days.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    : [];
  return { start, end, days: days.length ? days : [...WEEKDAYS] };
};

const SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** ISO weekdays back to words: [1,2,3,4,5] → "Mon-Fri", [1,3,5] → "Mon, Wed, Fri". */
export const formatDays = (days: number[]) => {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return "";
  }
  const first = sorted[0] as number;
  const last = sorted.at(-1) as number;
  const consecutive = sorted.length === last - first + 1;
  return consecutive && sorted.length > 2
    ? `${SHORT[first]}-${SHORT[last]}`
    : sorted.map((d) => SHORT[d]).join(", ");
};

/** "Mon-Fri 15:30–24:00" */
export const formatShift = (shift: Shift) =>
  `${formatDays(shift.days)} ${shift.start}–${shift.end}`;
