import { database } from "@repo/database";
import { notFound, redirect } from "next/navigation";
import { ensurePersonalFolder } from "@/lib/library/personal";
import { libraryEnabled } from "@/lib/library/stage";
import { resolveViewer } from "@/lib/library/viewer";

/** Your Personal folder (the sidebar links here; every member has their own). */
const PersonalPage = async () => {
  const viewer = await resolveViewer();
  if (!(viewer?.userId && (await libraryEnabled(viewer.orgId)))) {
    notFound();
  }
  await ensurePersonalFolder(viewer);
  const folder = await database.folder.findFirst({
    where: { orgId: viewer.orgId, personalUserId: viewer.userId },
    select: { id: true },
  });
  if (!folder) {
    notFound();
  }
  redirect(`/library/f/${folder.id}`);
};

export default PersonalPage;
