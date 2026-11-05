// Number and date formatting for the price build-up.

export const round = (value: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

export const money = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const shortDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

export const DAY_MS = 86_400_000;

export const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) /
      DAY_MS
  );

export const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

// ---------------------------------------------------------------------------
// Units and stock
