import "server-only";

import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { audit } from "./audit";
import { authorizeDocument } from "./guard";
import type { Outcome } from "./lifecycle";
import { keyBelongsTo, objectStore, SIGNED_URL_SECONDS } from "./storage";
import { trustedViewer, type Viewer } from "./viewer";

// Opening or downloading a document's original file. The document and
// version are looked up in the viewer's shop by id; the stored key comes
// from that row (never from the request) and must sit under that shop's and
// document's prefix. Only then is a link made, valid for a minute, and the
// access is written to the audit log.

export interface FileRequest {
  /** Download (needs "download") rather than open in the browser ("view"). */
  download: boolean;
  /** A version number; the current version when not given. */
  version?: number;
}

export const NOT_KEPT =
  "The original file of this version wasn't kept: it was added before Takumo kept original files. Its text is still searchable.";

export const fileLink = async (
  viewer: Viewer,
  sourceId: string,
  request: FileRequest
): Promise<Outcome<{ url: string }>> => {
  const { orgId, userId } = trustedViewer(viewer);
  const allowed = await authorizeDocument(
    viewer,
    sourceId,
    request.download ? "download" : "view"
  );
  if (!allowed.ok) {
    return allowed;
  }
  const version = await database.documentVersion.findFirst({
    where: {
      orgId,
      sourceId,
      ...(request.version === undefined
        ? { id: allowed.source.currentVersionId ?? "" }
        : { number: request.version }),
      status: { not: "uploading" },
    },
    select: {
      id: true,
      number: true,
      name: true,
      storageKey: true,
      originalKept: true,
    },
  });
  if (!version) {
    return { ok: false, status: 404, error: "That version doesn't exist." };
  }
  if (!(version.originalKept && version.storageKey)) {
    return { ok: false, status: 410, error: NOT_KEPT };
  }
  if (!keyBelongsTo(version.storageKey, orgId, sourceId)) {
    log.error("A document version's file is stored outside its document", {
      orgId,
      versionId: version.id,
    });
    return { ok: false, status: 404, error: "That version doesn't exist." };
  }
  const store = objectStore();
  if (!store) {
    return {
      ok: false,
      status: 503,
      error: "Original files can't be opened right now. Try again later.",
    };
  }
  const url = await store.signedUrl(version.storageKey, {
    seconds: SIGNED_URL_SECONDS,
    downloadAs: request.download ? version.name : undefined,
  });
  await audit({
    orgId,
    actorId: userId,
    action: request.download ? "download" : "preview",
    sourceId,
    versionId: version.id,
    folderId: allowed.source.folderId,
    subjectName: allowed.source.name,
    detail: { version: version.number },
  });
  return { ok: true, url };
};
