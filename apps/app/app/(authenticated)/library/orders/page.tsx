import type { Metadata } from "next";
import { poRecords } from "@/lib/library/virtual";
import { RecordList } from "../components/records";
import { LibraryShell } from "../components/shell";
import { libraryFrame, ROOT_CRUMB } from "../load";

export const metadata: Metadata = {
  title: "Purchase orders · Company Knowledge",
};

const PoFolderPage = async () => {
  const { viewer, folders } = await libraryFrame();
  const records = await poRecords(viewer);
  return (
    <LibraryShell
      crumbs={[ROOT_CRUMB, { label: "Purchase orders" }]}
      description="The files that came with each customer PO. They stay with the PO: open it under Incoming POs to work on it."
      folders={folders}
      title="Purchase orders"
    >
      <RecordList
        empty="No purchase orders with files yet."
        records={records}
      />
    </LibraryShell>
  );
};

export default PoFolderPage;
