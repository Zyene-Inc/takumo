import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { FileImageIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { fileKind, fileSize, shortDate } from "@/lib/library/format";
import type { DocumentRow } from "@/lib/library/rows";
import { DocumentMenu } from "./document-menu";
import type { FolderChoice } from "./move-dialog";
import { RefreshWhileBusy, StatusBadge } from "./status";

const BUSY = new Set(["uploading", "queued", "processing"]);

export const isBusy = (rows: DocumentRow[]) =>
  rows.some((r) => BUSY.has(r.state));

/**
 * Documents as a table: what each is, where it is, who added it, its
 * version and its real processing state, with the actions the viewer may
 * take. `extra` adds a column (Trash details); `below` adds a line under
 * each name (search: why it matched), which wraps instead of widening the
 * table.
 */
export const DocumentTable = ({
  below,
  choices,
  documents,
  extra,
  showFolder = false,
}: {
  below?: (row: DocumentRow) => ReactNode;
  choices: FolderChoice[];
  documents: DocumentRow[];
  extra?: { head: string; cell: (row: DocumentRow) => ReactNode };
  showFolder?: boolean;
}) => (
  <div className="overflow-x-auto rounded-lg border">
    <RefreshWhileBusy busy={isBusy(documents)} />
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          {showFolder && (
            <TableHead className="hidden sm:table-cell">Folder</TableHead>
          )}
          <TableHead className="hidden md:table-cell">Type</TableHead>
          <TableHead className="hidden lg:table-cell">Uploaded by</TableHead>
          <TableHead className="hidden md:table-cell">Added</TableHead>
          <TableHead className="hidden text-right lg:table-cell">
            Size
          </TableHead>
          <TableHead className="hidden sm:table-cell">Version</TableHead>
          <TableHead>Status</TableHead>
          {extra && <TableHead>{extra.head}</TableHead>}
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((d) => {
          const Icon = d.current?.mimeType?.startsWith("image/")
            ? FileImageIcon
            : FileTextIcon;
          return (
            <TableRow key={d.id}>
              <TableCell
                className={
                  below
                    ? "min-w-40 max-w-56 whitespace-normal sm:min-w-64 sm:max-w-md"
                    : "max-w-72"
                }
              >
                <Link
                  className="flex items-center gap-2 font-medium hover:underline focus-visible:underline"
                  href={`/library/d/${d.id}`}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate" title={d.name}>
                    {d.name}
                  </span>
                </Link>
                {d.docType && (
                  <span className="ml-6 text-muted-foreground text-xs capitalize">
                    {d.docType}
                  </span>
                )}
                {below && <div className="mt-1 ml-6">{below(d)}</div>}
              </TableCell>
              {showFolder && (
                <TableCell className="hidden max-w-40 truncate text-muted-foreground sm:table-cell">
                  {d.folder ? (
                    <Link
                      className="hover:underline"
                      href={`/library/f/${d.folder.id}`}
                    >
                      {d.folder.name}
                    </Link>
                  ) : (
                    "Top level"
                  )}
                </TableCell>
              )}
              <TableCell className="hidden text-muted-foreground md:table-cell">
                {fileKind(d.current?.mimeType ?? null, d.name)}
              </TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">
                {d.uploadedBy ? (
                  d.uploaderName
                ) : (
                  <span title="Added before Takumo recorded who uploads documents">
                    Historical (not recorded)
                  </span>
                )}
              </TableCell>
              <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                {shortDate(d.createdAt)}
              </TableCell>
              <TableCell className="hidden whitespace-nowrap text-right text-muted-foreground lg:table-cell">
                {d.current?.size ? fileSize(d.current.size) : "—"}
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                {d.current ? `v${d.current.number}` : "—"}
              </TableCell>
              <TableCell>
                <StatusBadge newVersion={d.stateIsNewVersion} state={d.state} />
              </TableCell>
              {extra && <TableCell>{extra.cell(d)}</TableCell>}
              <TableCell className="w-10 text-right">
                <DocumentMenu choices={choices} document={d} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  </div>
);
