import Link from "next/link";

const ago = (at: Date, now: number) => {
  const hours = Math.round((now - at.getTime()) / 3_600_000);
  if (hours < 1) {
    return "less than an hour ago";
  }
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return `${Math.round(hours / 24)} days ago`;
};

/**
 * In place of "Add …" when the shop's ERP sends this data: it's entered in
 * the ERP, and Takumo reads it from there.
 */
export const ErpFeedNote = ({ at }: { at: Date | null | undefined }) => (
  <Link
    className="text-muted-foreground text-sm hover:underline"
    href="/settings/integrations/email"
    title="Add or change these in your ERP; the next report brings them here."
  >
    From your ERP
    {at
      ? ` · updated ${ago(at, Date.now())}`
      : " · waiting for the first report"}
  </Link>
);
