import "server-only";

import { database, forOrg } from "@repo/database";
import { extractPages } from "../knowledge/extract";
import {
  DUPLICATE_DAYS,
  duplicateKey,
  expandPackage,
  extensionOf,
  type IncomingFile,
  kindOf,
  mediaTypeOf,
  requestText,
  senderAddress,
  sha256Of,
  subjectKey,
  withinLimits,
} from "./attachments";
import type { RfqFileKind } from "./types";

// The files kept with each RFQ (RfqFile, docs/PRODUCT-PLAN.md F2.1): saved
// once at intake, read again by the drawing reader (F2.2) and shown beside
// the quote. The bytes are only ever loaded by rfqFileBytes.

export interface PreparedFile {
  bytes: Uint8Array;
  kind: RfqFileKind;
  mediaType: string;
  name: string;
  pages: number | null;
  sha256: string;
}

/** A PDF's text, page by page (null when it can't be opened). */
const pdfPages = async (file: IncomingFile) => {
  try {
    const pages = await extractPages(file.name, file.bytes.slice());
    return pages.map((p) => p.text);
  } catch {
    return null;
  }
};

/**
 * Unpack, classify, hash and size-check the files that came with an RFQ.
 * `skipped` lists what was left out, in words for the estimator.
 */
export const prepareFiles = async (
  incoming: IncomingFile[]
): Promise<{ files: PreparedFile[]; skipped: string[] }> => {
  const expanded = expandPackage(incoming);
  const hashed = expanded.files.map((f) => ({
    ...f,
    sha256: sha256Of(f.bytes),
  }));
  const { kept, skipped } = withinLimits(hashed);
  const files: PreparedFile[] = [];
  for (const file of kept) {
    const pages =
      extensionOf(file.name) === ".pdf" ? await pdfPages(file) : null;
    files.push({
      name: file.name.slice(0, 250),
      bytes: file.bytes,
      sha256: file.sha256,
      mediaType: mediaTypeOf(file.name),
      kind: kindOf(file.name, pages),
      pages: pages ? pages.length : null,
    });
  }
  return { files, skipped: [...expanded.skipped, ...skipped] };
};

/** How many recent text-only RFQs the text comparison looks through. */
const TEXT_CANDIDATES = 300;

const duplicateSince = () =>
  new Date(Date.now() - DUPLICATE_DAYS * 24 * 60 * 60 * 1000);

/**
 * A text-only RFQ from the last week asking the same thing (F2.1-R7): the
 * customer sent it again, or two people forwarded it. Any sender, since a
 * forward comes from the person forwarding; the request text must match
 * exactly (requestText) and so must the subject (subjectKey), so two RFQs
 * on one template that name different parts only in the subject stay two.
 * Mail screened out as not an RFQ is never the original.
 */
const findSameText = async (
  orgId: string,
  text: { body: string; subject: string | null }
) => {
  const wanted = requestText(text.subject, text.body);
  if (!wanted) {
    return null;
  }
  const subject = subjectKey(text.subject);
  const recent = await forOrg(database, orgId).rfq.findMany({
    where: {
      receivedAt: { gte: duplicateSince() },
      files: { none: {} },
      status: { not: "filtered" },
    },
    orderBy: { receivedAt: "desc" },
    take: TEXT_CANDIDATES,
    select: { id: true, number: true, subject: true, body: true },
  });
  // The earliest one, so every repeat points at the RFQ people work on.
  return (
    recent
      .reverse()
      .find(
        (r) =>
          subjectKey(r.subject) === subject &&
          requestText(r.subject, r.body) === wanted
      ) ?? null
  );
};

/**
 * An earlier RFQ from the last week that this one repeats (F2.1-R7), or
 * null. With files: the same sender and the same set of files, so one extra
 * drawing makes it a new RFQ. Without: the same request text.
 */
export const findDuplicate = async (
  orgId: string,
  text: { body: string; sender: string | null; subject: string | null },
  files: PreparedFile[]
) => {
  const { sender } = text;
  const key = duplicateKey(
    sender,
    files.map((f) => f.sha256)
  );
  if (!key) {
    return await findSameText(orgId, text);
  }
  const db = forOrg(database, orgId);
  const since = duplicateSince();
  const matches = await db.rfqFile.findMany({
    where: {
      sha256: { in: files.map((f) => f.sha256) },
      createdAt: { gte: since },
    },
    select: { rfqId: true },
    distinct: ["rfqId"],
    take: 20,
  });
  if (matches.length === 0) {
    return null;
  }
  const candidates = await db.rfq.findMany({
    where: { id: { in: matches.map((m) => m.rfqId) } },
    orderBy: { receivedAt: "asc" },
    select: {
      id: true,
      number: true,
      sender: true,
      files: { select: { sha256: true } },
    },
  });
  const address = senderAddress(sender);
  return (
    candidates.find(
      (c) =>
        senderAddress(c.sender) === address &&
        duplicateKey(
          c.sender,
          c.files.map((f) => f.sha256)
        ) === key
    ) ?? null
  );
};

/** Keep an RFQ's files. */
export const saveRfqFiles = async (
  orgId: string,
  rfqId: string,
  files: PreparedFile[]
) => {
  if (files.length === 0) {
    return;
  }
  // One at a time: a batch of 50 MB in one statement is needlessly heavy.
  for (const file of files) {
    await forOrg(database, orgId).rfqFile.create({
      data: {
        orgId,
        rfqId,
        name: file.name,
        mediaType: file.mediaType,
        size: file.bytes.length,
        sha256: file.sha256,
        kind: file.kind,
        pages: file.pages,
        data: Buffer.from(file.bytes),
      },
      select: { id: true },
    });
  }
};

const FILE_META = {
  id: true,
  name: true,
  mediaType: true,
  size: true,
  kind: true,
  pages: true,
  sha256: true,
  createdAt: true,
} as const;

export interface RfqFileMeta {
  createdAt: Date;
  id: string;
  kind: RfqFileKind;
  mediaType: string;
  name: string;
  pages: number | null;
  sha256: string;
  size: number;
}

/** An RFQ's files, without their bytes; drawings first. */
export const rfqFilesOf = async (
  orgId: string,
  rfqId: string,
  options: { kind?: RfqFileKind } = {}
): Promise<RfqFileMeta[]> => {
  const rows = await forOrg(database, orgId).rfqFile.findMany({
    where: { rfqId, ...(options.kind ? { kind: options.kind } : {}) },
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    select: FILE_META,
  });
  const order: RfqFileKind[] = [
    "drawing",
    "model",
    "document",
    "image",
    "other",
  ];
  return rows
    .map((r) => ({ ...r, kind: r.kind as RfqFileKind }))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
};

/** One file with its bytes (the download route and the drawing reader). */
export const rfqFileBytes = async (orgId: string, fileId: string) => {
  const row = await forOrg(database, orgId).rfqFile.findFirst({
    where: { id: fileId },
    select: { ...FILE_META, rfqId: true, data: true },
  });
  if (!row) {
    return null;
  }
  return {
    ...row,
    kind: row.kind as RfqFileKind,
    data: new Uint8Array(row.data),
  };
};
