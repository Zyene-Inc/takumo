import type { Metadata } from "next";
import { recentDocuments } from "@/lib/library/browse";
import { EmptyState } from "../../shop/components/format";
import { DocumentTable } from "../components/document-table";
import { LibraryShell } from "../components/shell";
import { libraryFrame, ROOT_CRUMB } from "../load";

export const metadata: Metadata = { title: "Recent · Company Knowledge" };

const RecentPage = async () => {
  const { viewer, folders, choices } = await libraryFrame();
  const documents = await recentDocuments(viewer);
  return (
    <LibraryShell
      crumbs={[ROOT_CRUMB, { label: "Recent" }]}
      description="Documents added or changed most recently."
      folders={folders}
      title="Recent"
    >
      {documents.length ? (
        <DocumentTable choices={choices} documents={documents} showFolder />
      ) : (
        <EmptyState>No documents yet.</EmptyState>
      )}
    </LibraryShell>
  );
};

export default RecentPage;
