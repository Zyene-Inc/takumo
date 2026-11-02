import "server-only";

import { database, forOrg } from "@repo/database";
import {
  checkPart,
  MAX_UPLOAD_BYTES,
  type PartInput,
  UPLOAD_PART_MAX_AGE_MS,
} from "./upload-limits";

/**
 * Keep one piece of an upload. Pieces arrive one per request (the host caps a
 * request at 4.5 MB); the total per upload is checked as they arrive.
 */
export const keepUploadPart = async (
  orgId: string,
  input: PartInput,
  bytes: Uint8Array
): Promise<string | null> => {
  const problem = checkPart(input, bytes.length);
  if (problem) {
    return problem;
  }
  const db = forOrg(database, orgId);
  const sofar = await db.uploadPart.aggregate({
    where: { uploadId: input.uploadId },
    _sum: { size: true },
  });
  if ((sofar._sum.size ?? 0) + bytes.length > MAX_UPLOAD_BYTES) {
    return "Upload up to 20 MB at once. Zip the drawings, or email the package to your RFQ address.";
  }
  await db.uploadPart.upsert({
    where: {
      orgId_uploadId_fileIndex_partIndex: {
        orgId,
        uploadId: input.uploadId,
        fileIndex: input.fileIndex,
        partIndex: input.partIndex,
      },
    },
    create: {
      orgId,
      uploadId: input.uploadId,
      fileIndex: input.fileIndex,
      partIndex: input.partIndex,
      name: input.name,
      size: bytes.length,
      data: Buffer.from(bytes),
    },
    update: { name: input.name, size: bytes.length, data: Buffer.from(bytes) },
  });
  return null;
};

/** The upload's files, put back together; its pieces are deleted. */
export const takeUpload = async (orgId: string, uploadId: string) => {
  const db = forOrg(database, orgId);
  const parts = await db.uploadPart.findMany({
    where: { uploadId },
    orderBy: [{ fileIndex: "asc" }, { partIndex: "asc" }],
  });
  await db.uploadPart.deleteMany({ where: { uploadId } });
  const files = new Map<number, { name: string; chunks: Uint8Array[] }>();
  for (const p of parts) {
    const file = files.get(p.fileIndex) ?? { name: p.name, chunks: [] };
    file.chunks.push(new Uint8Array(p.data));
    files.set(p.fileIndex, file);
  }
  return [...files.values()].map((f) => {
    const size = f.chunks.reduce((sum, c) => sum + c.length, 0);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of f.chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { name: f.name, bytes };
  });
};

/** Pieces of uploads nobody submitted (closed tab, failed upload). */
export const removeOldUploadParts = async (now = Date.now()) => {
  const { count } = await database.uploadPart.deleteMany({
    where: { createdAt: { lt: new Date(now - UPLOAD_PART_MAX_AGE_MS) } },
  });
  return count;
};
