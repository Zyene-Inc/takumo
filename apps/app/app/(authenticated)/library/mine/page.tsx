import type { Metadata } from "next";
import { myUploads, unreadableUploads } from "@/lib/library/browse";
import { trashNote } from "@/lib/library/format";
import { EmptyState } from "../../shop/components/format";
import { DocumentTable } from "../components/document-table";
import { LibraryShell } from "../components/shell";
import { libraryFrame, ROOT_CRUMB } from "../load";

export const metadata: Metadata = { title: "My uploads · Company Knowledge" };

/**
 * Documents this person uploaded, wherever they are (a view, not a folder),
 * and the ones Takumo couldn't read and moved to the Trash: not everyone can
 * open the Trash, so they're listed here rather than just disappearing.
 */
const MyUploadsPage = async () => {
  const { viewer, folders, choices } = await libraryFrame();
  const [documents, unreadable] = await Promise.all([
    myUploads(viewer),
    unreadableUploads(viewer),
  ]);
  return (
    <LibraryShell
      crumbs={[ROOT_CRUMB, { label: "My uploads" }]}
      description="Documents you uploaded, in whichever folder they're in. Documents added before Takumo recorded who uploads them aren't listed here."
      folders={folders}
      title="My uploads"
    >
      {documents.length > 0 && (
        <DocumentTable choices={choices} documents={documents} showFolder />
      )}
      {documents.length === 0 && unreadable.length === 0 && (
        <EmptyState>You haven't uploaded any documents yet.</EmptyState>
      )}
      {unreadable.length > 0 && (
        <section aria-labelledby="unreadable" className="grid gap-2">
          <h2 className="font-medium" id="unreadable">
            Couldn't be read
          </h2>
          <p className="max-w-3xl text-muted-foreground text-sm">
            Takumo tried several times and couldn't read these, so it moved them
            to the Trash. Upload them again (a PDF usually works), or ask
            someone who manages documents to restore them.
          </p>
          <DocumentTable
            below={(row) => (
              <span className="text-muted-foreground text-xs">
                {trashNote(row)}
              </span>
            )}
            choices={choices}
            documents={unreadable}
            showFolder
          />
        </section>
      )}
    </LibraryShell>
  );
};

export default MyUploadsPage;
