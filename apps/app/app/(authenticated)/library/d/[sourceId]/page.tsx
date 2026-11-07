import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { DownloadIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { documentDetail, type VersionLabel } from "@/lib/library/detail";
import {
  dateTime,
  fileKind,
  fileSize,
  shortDate,
  trashNote,
} from "@/lib/library/format";
import { DocumentMenu } from "../../components/document-menu";
import { Preview } from "../../components/preview";
import { LibraryShell } from "../../components/shell";
import { RefreshWhileBusy, StatusBadge } from "../../components/status";
import { RetryVersion, UploadNewVersion } from "../../components/upload";
import { libraryFrame, ROOT_CRUMB } from "../../load";

export const metadata: Metadata = { title: "Document · Company Knowledge" };

const VERSION_LABEL: Record<
  VersionLabel,
  { text: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  active: { text: "Active", variant: "default" },
  previous: { text: "Previous", variant: "secondary" },
  replaced: { text: "Replaced before use", variant: "outline" },
  uploading: { text: "Uploading", variant: "outline" },
  queued: { text: "Queued", variant: "outline" },
  processing: { text: "Processing", variant: "secondary" },
  failed: { text: "Failed", variant: "destructive" },
};

const Detail = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);

const DocumentPage = async ({
  params,
}: {
  params: Promise<{ sourceId: string }>;
}) => {
  const { sourceId } = await params;
  const { viewer, folders, choices } = await libraryFrame();
  const detail = await documentDetail(viewer, sourceId);
  if (!detail) {
    notFound();
  }
  const { document: d } = detail;
  const trashed = d.deletedAt !== null;
  const busy = detail.versions.some((v) =>
    ["uploading", "queued", "processing"].includes(v.label)
  );
  const original = detail.versions.at(-1)?.number ?? null;
  return (
    <LibraryShell
      actions={
        <>
          {!trashed && d.canEdit && (
            <UploadNewVersion name={d.name} sourceId={d.id} />
          )}
          <DocumentMenu choices={choices} document={d} />
        </>
      }
      crumbs={[
        ROOT_CRUMB,
        ...detail.trail.map((t) => ({
          label: t.name,
          href: `/library/f/${t.id}`,
        })),
        { label: d.name },
      ]}
      folders={folders}
      title={d.name}
    >
      <RefreshWhileBusy busy={busy} />
      {trashed && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          {trashNote(d)} It doesn't appear in the library, search or Ask
          Takumo's document search.{" "}
          {d.canDelete ? "Restore it from the menu." : ""}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Preview
          current={d.current}
          failed={d.state === "failed"}
          name={d.name}
          sourceId={d.id}
          text={detail.text}
        />
        <div className="grid content-start gap-6">
          <section aria-labelledby="details" className="grid gap-2">
            <h2 className="font-medium" id="details">
              Details
            </h2>
            <dl className="grid gap-1.5">
              <Detail label="Status">
                <StatusBadge newVersion={d.stateIsNewVersion} state={d.state} />
              </Detail>
              {detail.originalName && (
                <Detail label="Original file">{detail.originalName}</Detail>
              )}
              <Detail label="Type">
                {fileKind(d.current?.mimeType ?? null, detail.originalName)}
              </Detail>
              {detail.classification && (
                <Detail label="Takumo read it as">
                  {detail.classification}
                </Detail>
              )}
              <Detail label="Size">{fileSize(d.current?.size)}</Detail>
              <Detail label="Folder">
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
              </Detail>
              <Detail label="Uploaded by">
                {d.uploadedBy
                  ? d.uploaderName
                  : "Historical: not recorded (added before Takumo recorded uploaders)"}
              </Detail>
              <Detail label="Uploaded">{dateTime(d.createdAt)}</Detail>
              <Detail label="Last updated">{dateTime(d.updatedAt)}</Detail>
              <Detail label="Current version">
                {d.current ? `Version ${d.current.number}` : "None yet"}
              </Detail>
            </dl>
            {detail.summary && (
              <div className="grid gap-1">
                <h3 className="font-medium text-sm">Summary</h3>
                <p className="text-muted-foreground text-sm">
                  {detail.summary}
                </p>
              </div>
            )}
            {detail.linked.length > 0 && (
              <div className="grid gap-1">
                <h3 className="font-medium text-sm">About these records</h3>
                <ul className="flex flex-wrap gap-1">
                  {detail.linked.map((l) => (
                    <li key={`${l.href}-${l.label}`}>
                      <Badge asChild variant="outline">
                        <Link href={l.href}>{l.label}</Link>
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      </div>
      <section aria-labelledby="versions" className="grid gap-2">
        <h2 className="font-medium" id="versions">
          Versions
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead className="hidden sm:table-cell">File</TableHead>
                <TableHead className="hidden lg:table-cell">
                  Uploaded by
                </TableHead>
                <TableHead className="hidden sm:table-cell">Date</TableHead>
                <TableHead className="hidden text-right lg:table-cell">
                  Size
                </TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="whitespace-nowrap">
                    Version {v.number}
                    {v.number === original && detail.versions.length > 1 && (
                      <span className="text-muted-foreground"> (original)</span>
                    )}{" "}
                    <Badge variant={VERSION_LABEL[v.label].variant}>
                      {VERSION_LABEL[v.label].text}
                    </Badge>
                    {/* On phones the File column is hidden: its notes go here. */}
                    {v.error && (
                      <span className="block whitespace-normal text-destructive text-xs sm:hidden">
                        {v.error}
                      </span>
                    )}
                    {!v.originalKept && (
                      <span className="block text-muted-foreground text-xs sm:hidden">
                        Original file not kept
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-64 sm:table-cell">
                    <span className="block truncate">{v.name}</span>
                    {v.error && (
                      <span className="text-destructive text-xs">
                        {v.error}
                      </span>
                    )}
                    {!v.originalKept && (
                      <span className="block text-muted-foreground text-xs">
                        Original file not kept
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {v.uploaderName}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                    {shortDate(v.createdAt)}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right text-muted-foreground lg:table-cell">
                    {fileSize(v.size)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {v.originalKept && v.label !== "uploading" && !trashed && (
                      <Button asChild size="sm" variant="ghost">
                        <a
                          aria-label={`Download version ${v.number}`}
                          href={`/api/library/documents/${d.id}/file?version=${v.number}&download=1`}
                        >
                          <DownloadIcon />
                        </a>
                      </Button>
                    )}
                    {v.canRetry && !trashed && (
                      <RetryVersion sourceId={d.id} versionId={v.id} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
      <section aria-labelledby="activity" className="grid gap-2">
        <h2 className="font-medium" id="activity">
          Activity
        </h2>
        {detail.activity.length ? (
          <ol className="grid gap-1 text-sm">
            {detail.activity.map((a) => (
              <li className="flex flex-wrap gap-x-2" key={a.id}>
                <span className="text-muted-foreground tabular-nums">
                  {dateTime(a.at)}
                </span>
                <span>{a.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground text-sm">
            Nothing recorded yet. Documents added before the library have no
            history from before then.
          </p>
        )}
      </section>
    </LibraryShell>
  );
};

export default DocumentPage;
