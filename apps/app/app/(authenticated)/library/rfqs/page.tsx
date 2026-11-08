import type { Metadata } from "next";
import { rfqRecords } from "@/lib/library/virtual";
import { RecordList } from "../components/records";
import { LibraryShell } from "../components/shell";
import { libraryFrame, ROOT_CRUMB } from "../load";

export const metadata: Metadata = { title: "RFQs · Company Knowledge" };

const RfqFolderPage = async () => {
  const { viewer, folders } = await libraryFrame();
  const records = await rfqRecords(viewer);
  return (
    <LibraryShell
      crumbs={[ROOT_CRUMB, { label: "RFQs" }]}
      description="The files that came with each RFQ. They stay with the RFQ: open it in Quotes to work on it."
      folders={folders}
      title="RFQs"
    >
      <RecordList empty="No RFQs with files yet." records={records} />
    </LibraryShell>
  );
};

export default RfqFolderPage;
