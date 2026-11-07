import "server-only";

import { database, Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  cleanName,
  DOCUMENT,
  DocumentExistsError,
  isCard,
  LOCK_NAME_SQL,
  nameLock,
} from "../knowledge/documents";
import { audit } from "./audit";
import { sha256Hex } from "./files";
import { DocumentProblem, OriginalNotStoredError } from "./problems";
import { objectStore, originalKey } from "./storage";

// Documents and their versions. A document keeps one id for life; each file
// uploaded for it is a numbered version. Uploading a file whose name is
// taken never replaces anything: a new version is its own action, on the
// document, by someone allowed to edit it.
//
// A version row is written first (status "uploading"), then the original is
// stored, then it is queued for processing. If the server stops between the
// two, the library sweep removes the row and any stored bytes.

export interface IncomingFile {
  bytes: Uint8Array;
  /** Decided by checkDocumentFile from the bytes, never by the request. */
  mimeType: string;
  name: string;
}

export interface NewVersion {
  name: string;
  number: number;
  sourceId: string;
  versionId: string;
}

export { OriginalNotStoredError } from "./problems";

const isNameClash = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

/** Store the bytes, then queue the version; undo the version if storing fails. */
const storeAndQueue = async (
  orgId: string,
  version: { id: string; key: string | null; mimeType: string },
  bytes: Uint8Array,
  undo: () => Promise<unknown>
) => {
  const store = objectStore();
  if (store && version.key) {
    try {
      await store.put(version.key, bytes, version.mimeType);
    } catch (error) {
      log.warn("Storing an original document failed", {
        orgId,
        error: String(error),
      });
      await undo();
      // In case part of it was written: removed by the sweep.
      await database.storageDeletion.create({
        data: { orgId, keys: [version.key] },
      });
      // Whatever went wrong (Storage refused, the network failed), the
      // file isn't kept.
      throw new OriginalNotStoredError();
    }
  }
  const { count } = await database.documentVersion.updateMany({
    where: { id: version.id, orgId, status: "uploading" },
    data: {
      status: "queued",
      originalKept: Boolean(store && version.key),
      // Due now.
      nextAttemptAt: null,
    },
  });
  if (count === 0) {
    // The document was permanently deleted (or the upload given up) while
    // the file was being stored: its deletion may already have run, so the
    // file just stored would be left behind. Queue it for deletion too.
    if (store && version.key) {
      await database.storageDeletion.create({
        data: { orgId, keys: [version.key] },
      });
    }
    throw new DocumentProblem(
      "That document was deleted while the file was uploading.",
      { permanent: true }
    );
  }
};

/**
 * A new document, as version 1, uploaded by `userId` (from the server's own
 * session or a verified sender; never from the request). Throws
 * DocumentExistsError when a live document already has this name.
 */
export const createDocument = async (
  orgId: string,
  userId: string | null,
  file: IncomingFile,
  via: "upload" | "email",
  /** Checked by the caller (the viewer may add documents to it); null: the top. */
  folderId: string | null = null
): Promise<NewVersion> => {
  const name = cleanName(file.name);
  const sha256 = sha256Hex(file.bytes);
  const sourceId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const key = objectStore() ? originalKey(orgId, sourceId, 1, sha256) : null;
  try {
    await database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(LOCK_NAME_SQL, nameLock(orgId, name));
      const taken = await tx.source.findFirst({
        where: { orgId, name, folderId, deletedAt: null, ...DOCUMENT },
        select: { id: true },
      });
      if (taken) {
        throw new DocumentExistsError(name);
      }
      await tx.source.create({
        data: {
          id: sourceId,
          orgId,
          name,
          ...DOCUMENT,
          folderId,
          status: "processing",
          uploadedBy: userId,
          versionSeq: 1,
        },
      });
      await tx.documentVersion.create({
        data: {
          id: versionId,
          orgId,
          sourceId,
          number: 1,
          name: file.name.slice(0, 255),
          storageKey: key,
          mimeType: file.mimeType,
          size: file.bytes.length,
          sha256,
          uploadedBy: userId,
        },
      });
    });
  } catch (error) {
    // The unique index caught a clash the lock didn't (another path).
    throw isNameClash(error) ? new DocumentExistsError(name) : error;
  }
  await storeAndQueue(
    orgId,
    { id: versionId, key, mimeType: file.mimeType },
    file.bytes,
    () => database.source.deleteMany({ where: { id: sourceId, orgId } })
  );
  await audit({
    orgId,
    actorId: userId,
    action: "upload",
    sourceId,
    versionId,
    subjectName: name,
    folderId,
    detail: { version: 1, via, size: file.bytes.length },
  });
  return { sourceId, versionId, number: 1, name };
};

// Hands out the next version number. The row lock it takes makes
// simultaneous uploads wait their turn, so numbers never repeat.
const NEXT_NUMBER_SQL = `
  update "Source" set "versionSeq" = "versionSeq" + 1, "updatedAt" = now()
  where id = $1 and "orgId" = $2 and "deletedAt" is null
    and type = 'upload' and profile = 'document'
  returning "versionSeq" as number, name`;

const nextNumber = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  sourceId: string
) => {
  const [row] = await tx.$queryRawUnsafe<{ name: string; number: number }[]>(
    NEXT_NUMBER_SQL,
    sourceId,
    orgId
  );
  return row ?? null;
};

/**
 * A new version of an existing document. The caller has already checked
 * that `userId` may edit it. Null when the document isn't a live document of
 * this shop. The document stays as it is until this version has finished
 * processing.
 */
export const createVersion = async (
  orgId: string,
  userId: string,
  sourceId: string,
  file: IncomingFile
): Promise<NewVersion | null> => {
  const sha256 = sha256Hex(file.bytes);
  const versionId = crypto.randomUUID();
  const store = objectStore();
  const made = await database.$transaction(async (tx) => {
    const next = await nextNumber(tx, orgId, sourceId);
    if (!next) {
      return null;
    }
    const key = store
      ? originalKey(orgId, sourceId, next.number, sha256)
      : null;
    await tx.documentVersion.create({
      data: {
        id: versionId,
        orgId,
        sourceId,
        number: next.number,
        name: file.name.slice(0, 255),
        storageKey: key,
        mimeType: file.mimeType,
        size: file.bytes.length,
        sha256,
        uploadedBy: userId,
      },
    });
    return { ...next, key };
  });
  if (!made) {
    return null;
  }
  await storeAndQueue(
    orgId,
    { id: versionId, key: made.key, mimeType: file.mimeType },
    file.bytes,
    () => database.documentVersion.deleteMany({ where: { id: versionId } })
  );
  await audit({
    orgId,
    actorId: userId,
    action: "version_upload",
    sourceId,
    versionId,
    subjectName: made.name,
    detail: { version: made.number, size: file.bytes.length },
  });
  return { sourceId, versionId, number: made.number, name: made.name };
};

/** The current version's text: its saved pages, or (older documents) its passages. */
const currentText = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  sourceId: string,
  versionId: string
) => {
  const pages = await tx.documentPage.findMany({
    where: { orgId, versionId },
    orderBy: { position: "asc" },
    select: { page: true, text: true, recognized: true },
  });
  if (pages.length > 0) {
    return pages;
  }
  // Passages overlap a little; that's harmless for reading them again.
  const chunks = (
    await tx.docChunk.findMany({
      where: { orgId, sourceId, versionId },
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      select: { content: true, page: true, meta: true },
    })
  ).filter((c) => !isCard(c.meta));
  const byPage = new Map<number | null, string[]>();
  for (const c of chunks) {
    byPage.set(c.page, [...(byPage.get(c.page) ?? []), c.content]);
  }
  return [...byPage.entries()]
    .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
    .map(([page, texts]) => ({
      page,
      text: texts.join("\n\n"),
      recognized: false,
    }));
};

/**
 * Read a document again from the text it already has (documents stored
 * before Takumo understood them): a new version with the same file, queued
 * after the reading step. Null when there's no live document or no text.
 */
export const createRereadVersion = async (
  orgId: string,
  userId: string | null,
  sourceId: string
): Promise<NewVersion | null> => {
  const versionId = crypto.randomUUID();
  const made = await database.$transaction(async (tx) => {
    const source = await tx.source.findFirst({
      where: { id: sourceId, orgId, deletedAt: null, ...DOCUMENT },
      select: { currentVersion: true },
    });
    const current = source?.currentVersion;
    if (!current) {
      return null;
    }
    const pages = await currentText(tx, orgId, sourceId, current.id);
    if (pages.length === 0) {
      return null;
    }
    const next = await nextNumber(tx, orgId, sourceId);
    if (!next) {
      return null;
    }
    await tx.documentVersion.create({
      data: {
        id: versionId,
        orgId,
        sourceId,
        number: next.number,
        name: current.name,
        storageKey: current.storageKey,
        originalKept: current.originalKept,
        mimeType: current.mimeType,
        size: current.size,
        sha256: current.sha256,
        uploadedBy: userId,
        status: "queued",
        stage: "understand",
        pageCount: pages.length,
        checkpoint: { recognized: pages.filter((p) => p.recognized).length },
      },
    });
    await tx.documentPage.createMany({
      data: pages.map((p, position) => ({
        orgId,
        versionId,
        position,
        page: p.page,
        text: p.text,
        recognized: p.recognized,
      })),
    });
    await audit(
      {
        orgId,
        actorId: userId,
        action: "reread",
        sourceId,
        versionId,
        subjectName: next.name,
        detail: { version: next.number, from: current.number },
      },
      tx
    );
    return next;
  });
  return made && { sourceId, versionId, number: made.number, name: made.name };
};
