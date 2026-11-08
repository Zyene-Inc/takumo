import { FolderIcon } from "lucide-react";
import Link from "next/link";
import type { FolderCard } from "@/lib/library/browse";
import { FolderMenu } from "./folder-dialogs";
import type { FolderChoice } from "./move-dialog";

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The folders inside the current one, as cards. */
export const FolderGrid = ({
  canManage,
  choices,
  folders,
  parentId,
}: {
  canManage: boolean;
  choices: FolderChoice[];
  folders: FolderCard[];
  parentId: string | null;
}) => (
  <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {folders.map((f) => (
      <li
        className="flex items-center gap-3 rounded-lg border p-3 focus-within:ring-2 focus-within:ring-ring"
        key={f.id}
      >
        <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
        <Link
          className="min-w-0 flex-1 outline-none"
          href={`/library/f/${f.id}`}
        >
          <span className="block truncate font-medium">{f.name}</span>
          <span className="text-muted-foreground text-xs">
            {count(f.documents, "document", "documents")}
            {f.folders > 0 && ` · ${count(f.folders, "folder", "folders")}`}
          </span>
        </Link>
        {canManage && f.kind === "normal" && (
          <FolderMenu
            choices={choices}
            folder={{ id: f.id, name: f.name, parentId }}
          />
        )}
      </li>
    ))}
  </ul>
);
