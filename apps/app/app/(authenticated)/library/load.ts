import "server-only";

import { notFound } from "next/navigation";
import { folderChoices, libraryNav } from "@/lib/library/browse";
import { libraryEnabled } from "@/lib/library/stage";
import { resolveViewer } from "@/lib/library/viewer";

/**
 * The person looking at a library page: an active member of a shop that
 * uses the library. Anything else is "not found", so the pages reveal
 * nothing to anyone else (and shops without the library keep the
 * Knowledge pages only).
 */
export const libraryViewer = async () => {
  const viewer = await resolveViewer();
  if (!(viewer && (await libraryEnabled(viewer.orgId)))) {
    notFound();
  }
  return viewer;
};

/** What every library page needs: its folders (navigation and "Move to"). */
export const libraryFrame = async () => {
  const viewer = await libraryViewer();
  const [folders, choices] = await Promise.all([
    libraryNav(viewer),
    folderChoices(viewer),
  ]);
  return { viewer, folders, choices };
};

export const ROOT_CRUMB = { label: "Company Knowledge", href: "/library" };
