import type { Metadata } from "next";
import { folderView } from "@/lib/library/browse";
import { EmptyState } from "../shop/components/format";
import { DocumentTable } from "./components/document-table";
import { NewFolderButton } from "./components/folder-dialogs";
import { FolderGrid } from "./components/folder-grid";
import { LibraryShell } from "./components/shell";
import { LibraryUpload } from "./components/upload";
import { libraryFrame, ROOT_CRUMB } from "./load";

export const metadata: Metadata = { title: "Company Knowledge · Takumo" };

const LibraryPage = async () => {
  const { viewer, folders, choices } = await libraryFrame();
  const view = await folderView(viewer, null);
  if (!view) {
    return null;
  }
  return (
    <LibraryShell
      actions={
        <>
          {view.canAdd && (
            <LibraryUpload folderId={null} folderName="the top level" />
          )}
          {view.canManage && <NewFolderButton parentId={null} />}
        </>
      }
      crumbs={[{ label: ROOT_CRUMB.label }]}
      description="Your company's documents, in one place. Everyone in the company can see them, and Ask Takumo searches them when it answers."
      folders={folders}
      title="All files"
    >
      {view.folders.length > 0 && (
        <FolderGrid
          canManage={view.canManage}
          choices={choices}
          folders={view.folders}
          parentId={null}
        />
      )}
      {view.documents.length > 0 ? (
        <section
          aria-label="Documents outside any folder"
          className="grid gap-2"
        >
          <h2 className="font-medium text-muted-foreground text-sm">
            Not in a folder
          </h2>
          <DocumentTable choices={choices} documents={view.documents} />
        </section>
      ) : (
        view.folders.length === 0 && (
          <EmptyState>No documents yet. Upload the first one.</EmptyState>
        )
      )}
    </LibraryShell>
  );
};

export default LibraryPage;
