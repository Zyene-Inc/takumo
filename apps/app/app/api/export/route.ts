import { can } from "@repo/auth/permissions";
import { database } from "@repo/database";
import { exportShop } from "@/lib/export/shop";
import { resolveViewer } from "@/lib/library/viewer";

// Downloading every record is the owner's or an admin's call.
export const maxDuration = 120;

/** The shop's data as a zip of CSV files (Settings → Billing). */
export const GET = async () => {
  const viewer = await resolveViewer();
  if (!viewer) {
    return new Response("Sign in and choose a shop first.", { status: 401 });
  }
  const { orgId, role } = viewer;
  if (!can(role, "billing:manage")) {
    return new Response(
      "Only the shop's owner or an admin can export its data.",
      { status: 403 }
    );
  }
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: { name: true },
  });
  const zip = await exportShop(viewer);
  const name = `${(org?.name ?? "takumo").replace(/[^\w.-]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.zip`;
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
};
