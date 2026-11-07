import type { Metadata } from "next";
import { trashedDocuments } from "@/lib/library/browse";
import { trashNote } from "@/lib/library/format";
import { EmptyState } from "../../shop/components/format";
import { DocumentTable } from "../components/document-table";
import { LibraryShell } from "../components/shell";
import { libraryFrame, ROOT_CRUMB } from "../load";

export const metadata: Metadata = { title: "Trash · Company Knowledge" };

const TrashPage = async () => {
  const { viewer, folders, choices } = await libraryFrame();
  const documents = await trashedDocuments(viewer);
  return (
    <LibraryShell
      crumbs={[ROOT_CRUMB, { label: "Trash" }]}
      description={
        <>
          Documents in the Trash don't appear in the library, in search or in
          Ask Takumo's document search, and can be restored. Facts already
          proposed from them stay under Knowledge → Facts until reviewed.
          Deleting permanently can't be undone.
        </>
      }
      folders={folders}
      title="Trash"
    >
      {documents.length ? (
        <DocumentTable
          below={(row) => (
            <span className="text-muted-foreground text-xs">
              {trashNote(row)}
            </span>
          )}
          choices={choices}
          documents={documents}
          showFolder
        />
      ) : (
        <EmptyState>The Trash is empty.</EmptyState>
      )}
    </LibraryShell>
  );
};

export default TrashPage;
