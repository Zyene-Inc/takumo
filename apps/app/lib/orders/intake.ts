import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { budgetProblem } from "../ai-usage";
import type { MailThread } from "../connectors/thread";
import { closeRfqWhenAnswered } from "../quotes/approve";
import { type PreparedFile, prepareFiles } from "../quotes/files";
import type { RfqText } from "../quotes/read";
import { quoteSettings } from "../quotes/settings";
import type { QuotedBreak } from "../quotes/types";
import { acceptedQuotes, checkPo, type QuoteRow } from "./check";
import { extractPo } from "./extract";
import type { PoLine } from "./types";

// A customer's purchase order coming in: kept, read, checked against the
// quotes, and left "to enter" for a person. Takumo never creates the order;
// the ERP's orders report brings it back (lib/orders/entered.ts).

const NUMBER_RETRIES = 5;
/** Quotes older than this aren't looked at for a PO. */
const QUOTE_LOOKBACK_DAYS = 365;

const num = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());

/** email | upload | paste: how the PO reached Takumo. */
const poSource = (source: RfqText["source"]) =>
  source === "upload" || source === "paste" ? source : "email";

const createPo = async (
  orgId: string,
  userId: string | null,
  text: RfqText,
  options: PoOptions
) => {
  const db = forOrg(database, orgId);
  for (let attempt = 0; ; attempt += 1) {
    const last = await db.customerPo.findFirst({
      orderBy: { number: "desc" },
      select: { number: true },
    });
    try {
      return await db.customerPo.create({
        data: {
          orgId,
          number: (last?.number ?? 0) + 1,
          source: poSource(text.source),
          sourceId: options.sourceId ?? null,
          sender: text.sender,
          subject: text.subject,
          body: text.body,
          customerId: options.customerId ?? null,
          createdBy: userId,
          ...(options.mail
            ? { extracted: { mail: options.mail } as object }
            : {}),
        },
        select: { id: true, number: true, receivedAt: true },
      });
    } catch (error) {
      const clash =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";
      if (!clash || attempt >= NUMBER_RETRIES) {
        throw error;
      }
    }
  }
};

const saveFiles = async (
  orgId: string,
  poId: string,
  files: PreparedFile[]
) => {
  try {
    for (const f of files) {
      await database.customerPoFile.create({
        data: {
          orgId,
          poId,
          name: f.name,
          mediaType: f.mediaType,
          size: f.bytes.length,
          sha256: f.sha256,
          data: Buffer.from(f.bytes),
        },
      });
    }
  } catch (error) {
    log.error("Saving PO files failed", { poId, error: String(error) });
  }
};

const fail = (orgId: string, poId: string, error: string) =>
  forOrg(database, orgId).customerPo.updateMany({
    where: { id: poId },
    data: { status: "failed", error },
  });

/** The quotes a PO could answer, in the shape the checks read. */
const loadQuotes = async (orgId: string): Promise<QuoteRow[]> => {
  const since = new Date(Date.now() - QUOTE_LOOKBACK_DAYS * 86_400_000);
  const rows = await forOrg(database, orgId).quote.findMany({
    where: { quotedAt: { gte: since }, status: { in: ["open", "won"] } },
    select: {
      id: true,
      quoteNo: true,
      customerId: true,
      qty: true,
      price: true,
      leadTimeDays: true,
      quotedAt: true,
      status: true,
      rfqId: true,
      breaks: true,
      part: { select: { partNo: true, rev: true } },
    },
  });
  return rows.map((q) => ({
    ...q,
    price: num(q.price),
    breaks: ((q.breaks as QuotedBreak[] | null) ?? []).map((b) => ({
      qty: b.qty,
      unitPrice: b.unitPrice,
      leadTimeDays: b.leadTimeDays,
    })),
  }));
};

/**
 * The quotes this PO clearly accepts become won, at the PO's quantity and
 * price, and their RFQs close. No order is made: that's the ERP's job.
 */
const acceptQuotes = async (orgId: string, lines: PoLine[]) => {
  for (const line of acceptedQuotes(lines)) {
    const unit = line.unitPrice ?? line.quote.unitPrice;
    await database.$transaction(async (tx) => {
      const won = await tx.quote.updateMany({
        where: { id: line.quote.quoteId, orgId, status: "open" },
        data: {
          status: "won",
          qty: line.qty,
          price: Math.round(unit * line.qty * 100) / 100,
          leadTimeDays: line.quote.leadTimeDays,
        },
      });
      if (won.count === 1 && line.quote.rfqId) {
        await closeRfqWhenAnswered(tx, orgId, line.quote.rfqId);
      }
    });
  }
};

/** Read and check a PO that's saved (status "reading"). Never throws. */
export const readPo = async (orgId: string, poId: string) => {
  const db = forOrg(database, orgId);
  try {
    const po = await db.customerPo.findFirst({
      where: { id: poId },
      select: {
        body: true,
        sender: true,
        receivedAt: true,
        extracted: true,
        customerId: true,
        files: { select: { name: true, data: true } },
      },
    });
    if (!po) {
      return;
    }
    const paused = await budgetProblem(orgId);
    if (paused) {
      await fail(orgId, poId, paused);
      return;
    }
    const read = await extractPo(orgId, {
      body: po.body,
      files: po.files.map((f) => ({
        name: f.name,
        bytes: new Uint8Array(f.data),
      })),
      receivedOn: po.receivedAt.toISOString().slice(0, 10),
    });
    if (!read.isPo || read.lines.length === 0) {
      await fail(
        orgId,
        poId,
        read.isPo
          ? "Takumo didn't find any lines on this PO."
          : "This doesn't look like a purchase order."
      );
      return;
    }
    const [customers, parts, quotes, settings] = await Promise.all([
      db.customer.findMany({
        select: { id: true, name: true, emails: true, domains: true },
      }),
      db.part.findMany({ select: { id: true, partNo: true, rev: true } }),
      loadQuotes(orgId),
      quoteSettings(orgId),
    ]);
    const checked = checkPo({
      header: read.header,
      lines: read.lines,
      sender: po.sender,
      customers,
      parts,
      quotes,
      today: new Date().toISOString().slice(0, 10),
      validityDays: settings.quoteValidityDays,
    });
    const customerId = checked.customerId ?? po.customerId;
    const customer = customerId
      ? customers.find((c) => c.id === customerId)
      : undefined;
    await db.customerPo.updateMany({
      where: { id: poId },
      data: {
        status: "review",
        error: null,
        poNo: read.header.poNo,
        customerId: customerId ?? null,
        customerName: customer?.name ?? read.header.customerName,
        contact: read.header.contact,
        lines: checked.lines as object,
        checks: checked.checks as object,
        extracted: {
          ...((po.extracted as object | null) ?? {}),
          header: read.header,
        } as object,
      },
    });
    await acceptQuotes(orgId, checked.lines);
  } catch (error) {
    log.warn("Reading a customer PO failed", { poId, error: String(error) });
    await fail(
      orgId,
      poId,
      "Takumo couldn't read this PO just now. Try again, or enter it from the file."
    );
  }
};

export interface PoOptions {
  /** Already matched (e.g. the mailbox screening knew the sender). */
  customerId?: string | null;
  mail?: MailThread | null;
  /** The message id, for POs from a mailbox (never read twice). */
  sourceId?: string | null;
}

export type PoIntakeResult =
  | { duplicate: true; id: string; number: number }
  | {
      duplicate: false;
      id: string;
      number: number;
      receivedAt: Date;
      skipped: string[];
    };

/** A new customer PO from any channel, read and checked straight away. */
export const intakePo = async (
  orgId: string,
  userId: string | null,
  text: RfqText,
  options: PoOptions = {}
): Promise<PoIntakeResult> => {
  if (options.sourceId) {
    const seen = await forOrg(database, orgId).customerPo.findFirst({
      where: { sourceId: options.sourceId },
      select: { id: true, number: true },
    });
    if (seen) {
      return { duplicate: true, ...seen };
    }
  }
  const { files, skipped } = await prepareFiles(text.files);
  const po = await createPo(orgId, userId, text, options);
  await saveFiles(orgId, po.id, files);
  await readPo(orgId, po.id);
  return { duplicate: false, skipped, ...po };
};
