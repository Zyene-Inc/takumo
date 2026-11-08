"use server";

import { revalidatePath } from "next/cache";
import {
  createFolder as create,
  moveFolder as moveDir,
  moveDocument as moveDoc,
  deleteFolder as remove,
  renameFolder as rename,
} from "@/lib/library/folders";
import { libraryEnabled } from "@/lib/library/stage";
import { resolveViewer, type Viewer } from "@/lib/library/viewer";

// Folder changes in the Company Knowledge Library. Who is asking comes from
// the server's session (an active member of the shop) and nothing else; the
// library's own checks (lib/library/folders.ts) decide what they may do.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const ID = /^[A-Za-z0-9-]{1,64}$/;

const asId = (value: unknown) =>
  typeof value === "string" && ID.test(value) ? value : null;

/** Null when the target is the top level; undefined when it isn't valid. */
const asParent = (value: unknown) =>
  value === null || value === "" ? null : (asId(value) ?? undefined);

const NOT_FOUND = { ok: false, error: "That folder doesn't exist." } as const;

const withViewer = async <T extends object>(
  run: (
    viewer: Viewer
  ) => Promise<
    ({ ok: true } & T) | { ok: false; error: string; status: number }
  >
): Promise<Result<T>> => {
  const viewer = await resolveViewer();
  if (!(viewer && (await libraryEnabled(viewer.orgId)))) {
    return NOT_FOUND;
  }
  const outcome = await run(viewer);
  revalidatePath("/library", "layout");
  return outcome.ok ? outcome : { ok: false, error: outcome.error };
};

export const createFolder = async (
  parentId: string | null,
  name: string
): Promise<Result<{ id: string }>> => {
  const parent = asParent(parentId);
  if (parent === undefined) {
    return NOT_FOUND;
  }
  return await withViewer((viewer) => create(viewer, parent, name));
};

export const renameFolder = async (
  folderId: string,
  name: string
): Promise<Result> => {
  const id = asId(folderId);
  return id
    ? await withViewer((viewer) => rename(viewer, id, name))
    : NOT_FOUND;
};

export const moveFolder = async (
  folderId: string,
  parentId: string | null
): Promise<Result> => {
  const id = asId(folderId);
  const parent = asParent(parentId);
  if (!id || parent === undefined) {
    return NOT_FOUND;
  }
  return await withViewer((viewer) => moveDir(viewer, id, parent));
};

export const deleteFolder = async (folderId: string): Promise<Result> => {
  const id = asId(folderId);
  return id ? await withViewer((viewer) => remove(viewer, id)) : NOT_FOUND;
};

export const moveDocument = async (
  sourceId: string,
  folderId: string | null
): Promise<Result> => {
  const id = asId(sourceId);
  const target = asParent(folderId);
  if (!id || target === undefined) {
    return { ok: false, error: "That document doesn't exist." };
  }
  return await withViewer((viewer) => moveDoc(viewer, id, target));
};
