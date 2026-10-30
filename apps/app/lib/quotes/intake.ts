import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { extractRfq } from "./extract";
import { partsMentioned } from "./match";
import type { RfqText } from "./read";

const NUMBER_RETRIES = 5;

/** Save the RFQ (status "reading") with the next number in the shop's series. */
const createRfq = async (
  orgId: string,
  userId: string | null,
  text: RfqText,
  fileName: string | null
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
          fileName,
          subject: text.subject,
          sender: text.sender,
          body: text.body,
          createdBy: userId,
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

/**
 * Read an RFQ's text into lines (Claude, checked against the shop's records)
 * and save them. The RFQ ends up "review", or "failed" with the reason.
 */
export const readRfq = async (orgId: string, rfqId: string) => {
  const db = forOrg(database, orgId);
  const rfq = await db.rfq.findFirst({
    where: { id: rfqId },
    select: { id: true, body: true, receivedAt: true },
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
          extracted: read.reading as object,
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
  } catch (error) {
    log.warn("Reading an RFQ failed", { rfqId, error: String(error) });
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

/** A new RFQ from an upload or a paste, read straight away. */
export const intakeRfq = async (
  orgId: string,
  userId: string | null,
  text: RfqText,
  fileName: string | null
) => {
  const rfq = await createRfq(orgId, userId, text, fileName);
  await readRfq(orgId, rfq.id);
  return rfq;
};
