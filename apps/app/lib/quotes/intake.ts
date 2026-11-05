import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { after } from "next/server";
import { recordFailedUsage, recordUsage } from "../ai-usage";
import type { MailThread } from "../connectors/thread";
import { intakePo } from "../orders/intake";
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
import type { Lane } from "./screen";
import {
  type MailboxContext,
  type ScreenNote,
  screenMailboxRfq,
} from "./screening";

const NUMBER_RETRIES = 5;

/** Save the RFQ (status "reading") with the next number in the shop's series. */
const createRfq = async (
  orgId: string,
  userId: string | null,
  text: RfqText,
  options: IntakeOptions,
  /** Kept on Rfq.extracted beside the reading: { mail, intake, screen }. */
  kept: object,
  /** Where screening put it: reading now, or waiting for a person. */
  lane: { status: string; customerId: string | null } = {
    status: "reading",
    customerId: null,
  }
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
          status: lane.status,
          customerId: lane.customerId,
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
      ? (extracted as { intake?: unknown; mail?: unknown; screen?: unknown })
      : {};
  return {
    ...(e.mail ? { mail: e.mail } : {}),
    ...(e.intake ? { intake: e.intake } : {}),
    ...(e.screen ? { screen: e.screen } : {}),
  };
};

/** Rfq.extracted.intake: what happened to the files at intake. */
interface IntakeNote {
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
    select: {
      id: true,
      body: true,
      receivedAt: true,
      extracted: true,
      customerId: true,
    },
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
          // The sender may already be matched to a customer (screening).
          customerId: read.customerId ?? rfq.customerId,
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
    // A package that is only drawings (scans, no RFQ text) has its parts on
    // the drawings: once they made lines, it's ready for review after all.
    if (!(read.isRfq && read.lines.length)) {
      const lines = await db.rfqLine.count({ where: { rfqId } });
      if (lines > 0) {
        await db.rfq.updateMany({
          where: { id: rfqId },
          data: { status: "review", error: null },
        });
      }
    }
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

interface IntakeOptions {
  /** Off for evals and tests that send the same files again on purpose. */
  checkDuplicates?: boolean;
  /** The uploaded file's name, when there was one. */
  fileName?: string | null;
  /** The mail thread, for replying in it and spotting the same RFQ again. */
  mail?: MailThread | null;
  /**
   * Read by Takumo from a connected mailbox: screen it first, so only real
   * RFQs from known senders get the full (paid) work. Unset for RFQs a person
   * uploaded, pasted, dictated or forwarded: they already judged it.
   */
  screen?: MailboxContext;
  /** The message id, for RFQs from a mailbox (never read twice). */
  sourceId?: string | null;
}

type IntakeResult =
  | {
      duplicate: false;
      id: string;
      number: number;
      receivedAt: Date;
      /**
       * full: read and drafted; po: a customer PO (id and number are the
       * PO's, in Incoming POs); otherwise waiting in the inbox.
       */
      lane: Lane;
      /** Files left out (too large, too many). */
      skipped: string[];
    }
  /** The same request as an RFQ from the last week: nothing new made. */
  | { duplicate: true; id: string; number: number };

/**
 * A new RFQ from any channel, read straight away. Its files are kept. When
 * the same request came in the last week (the same sender and files, or for
 * a text-only RFQ the same text, forwarded or not), no RFQ is made and the
 * earlier one is returned (F2.1-R7).
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
      : await findDuplicate(orgId, text, files);
  if (earlier) {
    return { duplicate: true, id: earlier.id, number: earlier.number };
  }
  const screening = options.screen
    ? await screenMailboxRfq(orgId, text, options.screen)
    : null;
  const lane: Lane = screening?.lane ?? "full";
  if (lane === "po") {
    // A customer's purchase order, not an RFQ: read into Incoming POs.
    const po = await intakePo(orgId, userId, text, {
      sourceId: options.sourceId,
      mail: options.mail,
      customerId: screening?.customerId ?? null,
    });
    return {
      duplicate: false,
      lane,
      id: po.id,
      number: po.number,
      receivedAt: po.duplicate ? new Date() : po.receivedAt,
      skipped: po.duplicate ? [] : po.skipped,
    };
  }
  const kept = {
    ...(options.mail ? { mail: options.mail } : {}),
    ...(skipped.length ? { intake: { skipped } satisfies IntakeNote } : {}),
    ...(screening
      ? {
          screen: {
            lane,
            reason: screening.reason,
            summary: screening.summary,
          } satisfies ScreenNote,
        }
      : {}),
  };
  const rfq = await createRfq(orgId, userId, text, options, kept, {
    status: lane === "full" ? "reading" : lane,
    customerId: screening?.customerId ?? null,
  });
  await keepFiles(orgId, rfq.id, files, kept);
  if (lane !== "full") {
    // Waits in the inbox for a person: nothing is read or priced yet.
    return { duplicate: false, lane, skipped, ...rfq };
  }
  await readRfq(orgId, rfq.id);
  if (options.sourceId) {
    // Arrived by email (a mailbox or the RFQ address): price it and put the
    // draft reply in the thread without anyone clicking (F2.5).
    draftLater(orgId, rfq.id);
  }
  return { duplicate: false, lane, skipped, ...rfq };
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

/** After the response (or the sync) finishes: estimate and draft the reply. */
const draftLater = (orgId: string, rfqId: string) => {
  const run = async () => {
    const { draftWhenReady } = await import("./mailbox-reply");
    await draftWhenReady(orgId, rfqId);
  };
  try {
    after(run);
  } catch {
    // Outside a request (a script): the estimator drafts it from the RFQ page.
    log.info("RFQ not drafted automatically (no request)", { rfqId });
  }
};

/**
 * Someone said "quote it" to an RFQ that waited in the inbox (new sender, or
 * filtered by mistake): read it now, then price it and draft the reply.
 */
export const startFullWork = async (orgId: string, rfqId: string) => {
  await readRfq(orgId, rfqId);
  draftLater(orgId, rfqId);
};
