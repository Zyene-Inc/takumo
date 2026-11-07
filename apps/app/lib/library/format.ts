// How the library shows sizes, dates and file types. Pure: shared by server
// and browser code, and tested on its own.

const UNITS = ["KB", "MB", "GB"] as const;

/** 1.2 MB, 340 KB; "—" when unknown. */
export const fileSize = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
};

const KINDS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "Word",
  "text/plain": "Text",
  "text/markdown": "Markdown",
  "text/csv": "CSV",
  "image/jpeg": "JPEG image",
  "image/png": "PNG image",
  "image/webp": "WebP image",
};

/** "PDF", "Word"…; from the stored media type, else the file name. */
export const fileKind = (mimeType: string | null, name?: string | null) => {
  if (mimeType && KINDS[mimeType]) {
    return KINDS[mimeType];
  }
  const dot = name?.lastIndexOf(".") ?? -1;
  return dot >= 0 && name ? name.slice(dot + 1).toUpperCase() : "Document";
};

/**
 * Files shown inside the document's page, sent by Takumo itself: at most
 * this size (under the 4.5 MB a response may carry on Vercel), and only
 * these types. Anything else is opened in a new tab.
 */
export const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
export const PREVIEW_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** How a file can be shown in the page. */
export const previewKind = (
  mimeType: string | null
): "pdf" | "image" | "text" => {
  if (mimeType === "application/pdf") {
    return "pdf";
  }
  return mimeType && PREVIEW_TYPES.has(mimeType) ? "image" : "text";
};

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

/** Nov 7, 2026 (UTC, so server and browser agree). */
export const shortDate = (date: Date) => DATE.format(date);

/** Nov 7, 2026, 3:04 PM UTC. */
export const dateTime = (date: Date) => `${DATE_TIME.format(date)} UTC`;

/**
 * What happened when a document was deleted for good, honestly: never
 * "deleted" while its stored files are still being removed.
 */
export const purgedMessage = (name: string, complete: boolean) =>
  complete
    ? `${name} was deleted permanently.`
    : `${name} was deleted. Its stored files are still being removed; Takumo finishes this automatically.`;

/**
 * When and why a document is in the Trash. Takumo itself only moves a
 * document there when it could never read it (lib/library/lease.ts).
 */
export const trashNote = (d: {
  current: unknown;
  deletedAt: Date | null;
  deletedBy: string | null;
  removerName: string | null;
}) => {
  if (!d.deletedAt) {
    return "";
  }
  const when = shortDate(d.deletedAt);
  if (d.deletedBy === null && d.current === null) {
    return `Moved to the Trash by Takumo on ${when}: it couldn't be read.`;
  }
  return `Moved to the Trash by ${d.removerName ?? "Takumo"} on ${when}.`;
};
