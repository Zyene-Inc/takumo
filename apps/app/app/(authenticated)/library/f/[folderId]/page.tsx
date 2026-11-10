import { LockIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { accessView } from "@/lib/library/access-view";
import { folderView } from "@/lib/library/browse";
import { EmptyState } from "../../../shop/components/format";
import { AccessBadges, AccessDialog } from "../../components/access-dialog";
import { DocumentTable } from "../../components/document-table";
import { FolderMenu, NewFolderButton } from "../../components/folder-dialogs";
import { FolderGrid } from "../../components/folder-grid";
import { LibraryShell } from "../../components/shell";
import { LibraryUpload } from "../../components/upload";
import { libraryFrame, ROOT_CRUMB } from "../../load";

export const metadata: Metadata = { title: "Folder · Company Knowledge" };

const FolderPage = async ({
  params,
}: {
  params: Promise<{ folderId: string }>;
}) => {
  const { folderId } = await params;
  const { viewer, folders, choices } = await libraryFrame();
  const [view, access] = await Promise.all([
    folderView(viewer, folderId),
    accessView(viewer, { folderId }),
  ]);
  if (!view?.folder) {
    notFound();
  }
  const { folder } = view;
  const empty = view.folders.length === 0 && view.documents.length === 0;
  return (
    <LibraryShell
      actions={
        <>
          {view.canAdd && (
            <LibraryUpload folderId={folder.id} folderName={folder.name} />
          )}
          {view.canManage && <NewFolderButton parentId={folder.id} />}
          {access?.restricting && (
            <AccessDialog
              initial={access}
              name={folder.name}
              target={{ folderId: folder.id }}
            />
          )}
          {view.canManage && folder.kind === "normal" && (
            <FolderMenu
              choices={choices}
              folder={folder}
              onDeletedHref={
                folder.parentId ? `/library/f/${folder.parentId}` : "/library"
              }
            />
          )}
        </>
      }
      crumbs={[
        ROOT_CRUMB,
        ...view.trail.map((t) => ({
          label: t.name,
          href: `/library/f/${t.id}`,
        })),
        { label: folder.name },
      ]}
      folders={folders}
      title={folder.name}
    >
      {view.personal && (
        <p className="flex max-w-3xl items-start gap-2 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-sky-900 text-sm">
          <LockIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            Only you can see this folder and what's in it, not even the shop's
            owner. Nothing here is shared or turned into shop facts; Ask Takumo
            can search it for you alone. If you leave the shop, it's deleted 30
            days later.
          </span>
        </p>
      )}
      {access && <AccessBadges view={access} />}
      {view.folders.length > 0 && (
        <FolderGrid
          canManage={view.canManage}
          choices={choices}
          folders={view.folders}
          parentId={folder.id}
        />
      )}
      {view.documents.length > 0 && (
        <DocumentTable choices={choices} documents={view.documents} />
      )}
      {empty && (
        <EmptyState>
          This folder is empty.
          {view.canAdd && " Upload documents to add them here."}
        </EmptyState>
      )}
    </LibraryShell>
  );
};

export default FolderPage;
