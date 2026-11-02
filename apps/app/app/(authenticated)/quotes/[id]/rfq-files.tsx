import { Badge } from "@repo/design-system/components/ui/badge";
import { DownloadIcon, EyeIcon } from "lucide-react";
import type { RfqFileMeta } from "@/lib/quotes/files";
import {
  type RfqFileKind,
  type RfqSource,
  SOURCE_LABEL,
} from "@/lib/quotes/types";

const KIND_LABEL: Record<RfqFileKind, string> = {
  drawing: "Drawing",
  model: "3D model",
  document: "Document",
  image: "Image",
  other: "File",
};

/** Opened in the browser rather than downloaded. */
export const VIEWABLE = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The files that came with an RFQ, and where it came from. */
export const RfqFiles = ({
  rfqId,
  source,
  files,
  skipped,
}: {
  files: RfqFileMeta[];
  rfqId: string;
  skipped: string[];
  source: string;
}) => {
  const channel = SOURCE_LABEL[source as RfqSource] ?? source;
  if (files.length === 0 && skipped.length === 0) {
    return (
      <p className="px-4 text-muted-foreground text-xs">
        Came in by {channel.toLowerCase()} · no files
      </p>
    );
  }
  const href = (id: string) => `/quotes/${rfqId}/files/${id}`;
  return (
    <section className="mx-4 rounded-xl border">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="font-medium text-sm">Files with this RFQ</h2>
        <span className="text-muted-foreground text-xs">
          Came in by {channel.toLowerCase()}
        </span>
      </div>
      <ul className="divide-y">
        {files.map((f) => (
          <li className="flex items-center gap-3 px-4 py-2 text-sm" key={f.id}>
            <Badge variant={f.kind === "drawing" ? "default" : "outline"}>
              {KIND_LABEL[f.kind]}
            </Badge>
            <a
              className="min-w-0 flex-1 truncate hover:underline"
              download={f.name}
              href={href(f.id)}
            >
              {f.name}
            </a>
            <span className="text-muted-foreground text-xs">
              {f.pages ? `${f.pages} page${f.pages === 1 ? "" : "s"} · ` : ""}
              {size(f.size)}
            </span>
            {VIEWABLE.includes(f.mediaType) && (
              <a
                aria-label={`View ${f.name}`}
                className="text-muted-foreground hover:text-foreground"
                href={`${href(f.id)}?view=1`}
                rel="noopener"
                target="_blank"
              >
                <EyeIcon className="size-4" />
              </a>
            )}
            <a
              aria-label={`Download ${f.name}`}
              className="text-muted-foreground hover:text-foreground"
              download={f.name}
              href={href(f.id)}
            >
              <DownloadIcon className="size-4" />
            </a>
          </li>
        ))}
      </ul>
      {skipped.length > 0 && (
        <p className="border-t px-4 py-2 text-muted-foreground text-xs">
          Left out: {skipped.join("; ")}
        </p>
      )}
    </section>
  );
};
