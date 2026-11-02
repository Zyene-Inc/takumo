import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { recordFailedUsage, recordUsage } from "../ai-usage";
import type { MailThread } from "../connectors/thread";
import { readDrawings } from "./drawing";
import { extractRfq } from "./extract";
import {
  findDuplicate,
  type PreparedFile,
  prepareFiles,
  saveRfqFiles,
} from "./files";
import { partsMentioned } from "./match";
import type { RfqText } from "./read";

const NUMBER_RETRIES = 5;

/** Save the RFQ (status "reading") with the next number in the shop's series. */
const createRfq = async (
  orgId: string,
  userId: string | null,
  text: RfqText,
  options: IntakeOptions,
  /** Kept on Rfq.extracted beside the reading: { mail, intake }. */
  kept: object
) => {
  for (let attempt = 0; ; attempt += 1) {
    const last = await forOrg(database, orgId).rfq.findFirst({
      orderBy: { number: "desc" },
      select: { number: true },
    });
    try {
      return await forOrg(database, orgId).rfq.create({
        data: {
          orgId,
          number: (last?.number ?? 0) + 1,
          source: text.source,
          sourceId: options.sourceId ?? null,
          fileName: options.fileName ?? null,
          subject: text.subject,
          sender: text.sender,
          body: text.body,
          createdBy: userId,
          // Kept through every reading (see readRfq).
          ...(Object.keys(kept).length ? { extracted: kept } : {}),
        },
        select: { id: true, number: true, receivedAt: true },
      });
    } catch (error) {
      // Two RFQs arrived at once and took the same number: take the next one.
      const clash =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";
      if (!clash || attempt >= NUMBER_RETRIES) {
        throw error;
      }
    }
  }
};

const readingProblem = (read: { isRfq: boolean; lines: unknown[] }) => {
  if (!read.isRfq) {
    return "This doesn't look like a request for quote.";
  }
  return read.lines.length
    ? null
    : "Takumo didn't find any parts to quote in this RFQ. Add the lines yourself.";
};

/** What intake keeps on Rfq.extracted, carried over each new reading. */
const keptKeys = (extracted: unknown) => {
  const e =
    extracted && typeof extracted === "object"
      ? (extracted as { intake?: unknown; mail?: unknown })
      : {};
  return {
    ...(e.mail ? { mail: e.mail } : {}),
    ...(e.intake ? { intake: e.intake } : {}),
  };
};

/** Rfq.extracted.intake: what happened to the files at intake. */
export interface IntakeNote {
  /** Files left out, with why (too large, too many). */
  skipped: string[];
}

/** Files left out of an RFQ at intake, from Rfq.extracted. */
export const intakeNoteOf = (extracted: unknown): IntakeNote | null => {
  const intake =
    extracted && typeof extracted === "object"
      ? (extracted as { intake?: unknown }).intake
      : null;
  if (!intake || typeof intake !== "object") {
    return null;
  }
  const skipped = (intake as { skipped?: unknown }).skipped;
  return {
    skipped: Array.isArray(skipped)
      ? skipped.filter((s): s is string => typeof s === "string")
      : [],
  };
};

/**
 * Read an RFQ's text into lines (Claude, checked against the shop's records)
 * and save them. The RFQ ends up "review", or "failed" with the reason.
 */
export const readRfq = async (orgId: string, rfqId: string) => {
  const db = forOrg(database, orgId);
  const rfq = await db.rfq.findFirst({
    where: { id: rfqId },
    select: { id: true, body: true, receivedAt: true, extracted: true },
  });
  if (!rfq) {
    return;
  }
  const [customers, materials, parts] = await Promise.all([
    db.customer.findMany({
      orderBy: { name: "asc" },
      take: 500,
      select: { id: true, name: true },
    }),
    db.material.findMany({
      orderBy: { name: "asc" },
      take: 500,
      select: { id: true, name: true },
    }),
    db.part.findMany({ select: { id: true, partNo: true, rev: true } }),
  ]);
  try {
    const read = await extractRfq(
      rfq.body,
      rfq.receivedAt.toISOString().slice(0, 10),
      { customers, materials, parts: partsMentioned(rfq.body, parts) }
    );
    await recordUsage(orgId, "rfq_read", read.usage.modelId, read.usage.tokens);
    await database.$transaction([
      database.rfqLine.deleteMany({ where: { orgId, rfqId } }),
      database.rfq.update({
        where: { id: rfqId },
        data: {
          customerName: read.customerName,
          customerId: read.customerId,
          contact: read.contact,
          requestedDate: read.requestedDate
            ? new Date(read.requestedDate)
            : null,
          notes: read.notes,
          // The mail thread it came from stays beside the new reading.
          extracted: {
            ...(read.reading as object),
            ...keptKeys(rfq.extracted),
          },
          status: read.isRfq && read.lines.length ? "review" : "failed",
          error: readingProblem(read),
        },
      }),
      database.rfqLine.createMany({
        data: read.lines.map((line) => ({
          orgId,
          rfqId,
          lineNo: line.lineNo,
          partNo: line.partNo,
          rev: line.rev,
          description: line.description,
          materialText: line.materialText,
          qtys: line.qtys,
          tolerances: line.tolerances,
          finish: line.finish,
          notes: line.notes,
          partId: line.partId,
          materialId: line.materialId,
        })),
      }),
    ]);
    await readDrawings(orgId, rfqId);
  } catch (error) {
    log.warn("Reading an RFQ failed", { rfqId, error: String(error) });
    await recordFailedUsage(orgId, "rfq_read", error);
    await db.rfq.updateMany({
      where: { id: rfqId },
      data: {
        status: "failed",
        error:
          "Takumo couldn't read this RFQ just now. Try again, or add the lines yourself.",
      },
    });
  }
};

export interface IntakeOptions {
  /** Off for evals and tests that send the same files again on purpose. */
  checkDuplicates?: boolean;
  /** The uploaded file's name, when there was one. */
  fileName?: string | null;
  /** The mail thread, for replying in it and spotting the same RFQ again. */
  mail?: MailThread | null;
  /** The message id, for RFQs from a mailbox (never read twice). */
  sourceId?: string | null;
}

export type IntakeResult =
  | {
      duplicate: false;
      id: string;
      number: number;
      receivedAt: Date;
      /** Files left out (too large, too many). */
      skipped: string[];
    }
  /** Same sender and files as an RFQ from the last week: nothing new made. */
  | { duplicate: true; id: string; number: number };

/**
 * A new RFQ from any channel, read straight away. Its files are kept. When
 * the same sender sent the same files in the last week, no RFQ is made and
 * the earlier one is returned (F2.1-R7).
 */
export const intakeRfq = async (
  orgId: string,
  userId: string | null,
  text: RfqText,
  options: IntakeOptions = {}
): Promise<IntakeResult> => {
  const { files, skipped } = await prepareFiles(text.files);
  const earlier =
    options.checkDuplicates === false
      ? null
      : await findDuplicate(orgId, text.sender, files);
  if (earlier) {
    return { duplicate: true, id: earlier.id, number: earlier.number };
  }
  const kept = {
    ...(options.mail ? { mail: options.mail } : {}),
    ...(skipped.length ? { intake: { skipped } satisfies IntakeNote } : {}),
  };
  const rfq = await createRfq(orgId, userId, text, options, kept);
  await keepFiles(orgId, rfq.id, files, kept);
  await readRfq(orgId, rfq.id);
  return { duplicate: false, skipped, ...rfq };
};

/** Saving the files must not lose the RFQ: a failure is logged and noted. */
const keepFiles = async (
  orgId: string,
  rfqId: string,
  files: PreparedFile[],
  kept: { intake?: IntakeNote; mail?: MailThread }
) => {
  try {
    await saveRfqFiles(orgId, rfqId, files);
  } catch (error) {
    log.error("Saving RFQ files failed", { rfqId, error: String(error) });
    await forOrg(database, orgId).rfq.updateMany({
      where: { id: rfqId },
      data: {
        extracted: {
          ...kept,
          intake: {
            skipped: [
              ...(kept.intake?.skipped ?? []),
              ...files.map((f) => `${f.name}: couldn't be saved`),
            ],
          } satisfies IntakeNote,
        } as object,
      },
    });
  }
};
