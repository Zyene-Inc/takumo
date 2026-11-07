import "server-only";

import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { audit } from "./audit";
import { PREVIEW_MAX_BYTES, PREVIEW_TYPES } from "./format";
import { authorizeDocument } from "./guard";
import type { Outcome } from "./lifecycle";
import {
  keyBelongsTo,
  type ObjectStore,
  objectStore,
  SIGNED_URL_SECONDS,
} from "./storage";
import { trustedViewer, type Viewer } from "./viewer";

// Opening or downloading a document's original file. The document and
// version are looked up in the viewer's shop by id; the stored key comes
// from that row (never from the request) and must sit under that shop's and
// document's prefix. Only then is a link made, valid for a minute (or, for
// the preview inside the document's page, the file is sent from Takumo
// itself), and the access is written to the audit log.

export interface FileRequest {
  /** Download (needs "download") rather than open in the browser ("view"). */
  download: boolean;
  /** A version number; the current version when not given. */
  version?: number;
}

export const NOT_KEPT =
  "The original file of this version wasn't kept: it was added before Takumo kept original files. Its text is still searchable.";

const MISSING = "That version doesn't exist.";

interface Located {
  folderId: string | null;
  sourceName: string;
  store: ObjectStore;
  version: {
    id: string;
    mimeType: string | null;
    name: string;
    number: number;
    size: number | null;
    storageKey: string;
  };
}

/** The version's stored original, after every check; never from the request. */
const locate = async (
  viewer: Viewer,
  sourceId: string,
  capability: "view" | "download",
  versionNumber: number | undefined
): Promise<Outcome<Located>> => {
  const { orgId } = trustedViewer(viewer);
  const allowed = await authorizeDocument(viewer, sourceId, capability);
  if (!allowed.ok) {
    return allowed;
  }
  const version = await database.documentVersion.findFirst({
    where: {
      orgId,
      sourceId,
      ...(versionNumber === undefined
        ? { id: allowed.source.currentVersionId ?? "" }
        : { number: versionNumber }),
      status: { not: "uploading" },
    },
    select: {
      id: true,
      number: true,
      name: true,
      mimeType: true,
      size: true,
      storageKey: true,
      originalKept: true,
    },
  });
  if (!version) {
    return { ok: false, status: 404, error: MISSING };
  }
  if (!(version.originalKept && version.storageKey)) {
    return { ok: false, status: 410, error: NOT_KEPT };
  }
  if (!keyBelongsTo(version.storageKey, orgId, sourceId)) {
    log.error("A document version's file is stored outside its document", {
      orgId,
      versionId: version.id,
    });
    return { ok: false, status: 404, error: MISSING };
  }
  const store = objectStore();
  if (!store) {
    return {
      ok: false,
      status: 503,
      error: "Original files can't be opened right now. Try again later.",
    };
  }
  return {
    ok: true,
    store,
    folderId: allowed.source.folderId,
    sourceName: allowed.source.name,
    version: { ...version, storageKey: version.storageKey },
  };
};

const recordAccess = (
  viewer: Viewer,
  sourceId: string,
  found: Located,
  action: "download" | "preview"
) => {
  const { orgId, userId } = trustedViewer(viewer);
  return audit({
    orgId,
    actorId: userId,
    action,
    sourceId,
    versionId: found.version.id,
    folderId: found.folderId,
    subjectName: found.sourceName,
    detail: { version: found.version.number },
  });
};

export const fileLink = async (
  viewer: Viewer,
  sourceId: string,
  request: FileRequest
): Promise<Outcome<{ url: string }>> => {
  const found = await locate(
    viewer,
    sourceId,
    request.download ? "download" : "view",
    request.version
  );
  if (!found.ok) {
    return found;
  }
  const url = await found.store.signedUrl(found.version.storageKey, {
    seconds: SIGNED_URL_SECONDS,
    downloadAs: request.download ? found.version.name : undefined,
  });
  await recordAccess(
    viewer,
    sourceId,
    found,
    request.download ? "download" : "preview"
  );
  return { ok: true, url };
};

/**
 * The current version's bytes for the preview inside the document's page.
 * The page can't frame a link to Storage (Takumo's pages only embed what
 * Takumo itself serves), so small PDFs and images are sent from here; larger
 * ones are opened in a new tab instead.
 */
export const previewFile = async (
  viewer: Viewer,
  sourceId: string
): Promise<Outcome<{ bytes: Uint8Array; mimeType: string; name: string }>> => {
  const found = await locate(viewer, sourceId, "view", undefined);
  if (!found.ok) {
    return found;
  }
  const { mimeType, size, name, storageKey } = found.version;
  if (!(mimeType && PREVIEW_TYPES.has(mimeType))) {
    return { ok: false, status: 415, error: "This file can't be shown here." };
  }
  if (size === null || size > PREVIEW_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: "This file is too large to show here. Open it in a new tab.",
    };
  }
  const bytes = await found.store.get(storageKey);
  await recordAccess(viewer, sourceId, found, "preview");
  return { ok: true, bytes, mimeType, name };
};
