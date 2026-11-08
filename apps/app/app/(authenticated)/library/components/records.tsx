import { Badge } from "@repo/design-system/components/ui/badge";
import { DownloadIcon, ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { fileSize, shortDate } from "@/lib/library/format";
import type { VirtualRecord } from "@/lib/library/virtual";
import { EmptyState } from "../../shop/components/format";

/**
 * RFQs or POs with the files that came with them: read-only, each linking to
 * the record itself and to its own file downloads (nothing is copied).
 */
export const RecordList = ({
  empty,
  records,
}: {
  empty: string;
  records: VirtualRecord[];
}) =>
  records.length ? (
    <ul className="grid gap-3">
      {records.map((r) => (
        <li className="grid gap-2 rounded-lg border p-3" key={r.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Link className="font-medium hover:underline" href={r.href}>
              {r.label}
            </Link>
            <Badge variant="secondary">{r.status}</Badge>
            <span className="text-muted-foreground text-xs">
              {r.party ? `${r.party} · ` : ""}received {shortDate(r.receivedAt)}
            </span>
            <Link
              className="ml-auto inline-flex items-center gap-1 text-primary text-sm hover:underline"
              href={r.href}
            >
              Open <ExternalLinkIcon className="size-3" />
            </Link>
          </div>
          <ul className="grid gap-1">
            {r.files.map((f) => (
              <li className="flex items-center gap-2 text-sm" key={f.id}>
                <a
                  aria-label={`Download ${f.name}`}
                  className="inline-flex min-w-0 items-center gap-2 hover:underline"
                  href={f.href}
                >
                  <DownloadIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{f.name}</span>
                </a>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {fileSize(f.size)}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  ) : (
    <EmptyState>{empty}</EmptyState>
  );
