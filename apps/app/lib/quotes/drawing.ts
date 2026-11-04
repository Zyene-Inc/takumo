import "server-only";

import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { budgetProblem, recordFailedUsage, recordUsage } from "../ai-usage";
import { inGroups, pdfPages } from "../knowledge/read";
import {
  assignParts,
  checkDrawing,
  linePatch,
  noDrawingReading,
} from "./drawing-check";
import {
  cleanPart,
  drawingAnswerSchema,
  mergeParts,
  type PartReading,
} from "./drawing-schema";
import { matchMaterial, matchPart } from "./match";
import { quoteSettings } from "./settings";
import { type DrawingReading, MAX_QTY_BREAKS } from "./types";

// Reads the drawings that came with an RFQ (docs/PRODUCT-PLAN.md F2.2): title
// block, material, finish, size, features, tolerances, notes, every value
// with where on the sheet it was read. Then checks them against the shop and
// puts them on the RFQ's lines.

/** Sheets read per drawing file, sheets per call, and calls at once. */
const MAX_SHEETS = 12;
const SHEETS_PER_CALL = 3;
const PARALLEL_CALLS = 3;
/** Drawing files read at once for one RFQ. */
const PARALLEL_FILES = 2;

const READ_DRAWING = `You are reading an engineering drawing for a machine shop that has to quote the part. Read what is printed; never guess, never convert units.

For each part number on these pages, return:
- Title block: part number, revision, title, drawing number, scale, "sheet n of m", the general tolerance block verbatim (e.g. ".XX ±.01 .XXX ±.005 ANGLES ±0.5°"), drawn and approved dates.
- Material callout as written (e.g. "AL 6061-T6 PER AMS-QQ-A-250/11"), with grade, condition and spec split out.
- Finishes and treatments: anodize (type/class/color), plating, heat treat, passivation, paint, each with its spec number.
- Overall size (envelope): length × width × height, or diameter × length for round parts, in the drawing's own units. Suggest the raw stock form and size.
- Features: holes (count, size, thru/blind), threads (spec, depth, count), pockets, slots, bores, chamfers/radii, knurls, keyways.
- Tolerances: the tightest dimensional tolerances (tolerance = the ± half-band; "+.001/-.000" is 0.0005), every GD&T frame (symbol, zone value, datums), surface finish (Ra).
- Notes: the numbered drawing notes, verbatim.
- Requirements: customer specs and certifications the notes call for (AS9100, ISO 9001, ITAR, NADCAP, first article/FAI, certificate of conformance, material certs).
- Quantities, only if printed on the drawing.

For every value give: the text exactly as printed; confidence (high when clearly printed, medium when partly unclear, low for scans, rotated or handwritten text, or anything you're unsure of); the page it is on (from 1, in this file); and its box [ymin, xmin, ymax, xmax] on that page, 0–1000.
Leave out what isn't on the drawing. Units: "in" or "mm" as the drawing states (title block or dimensions), else "unknown".`;

export interface DrawingFile {
  data: Uint8Array;
  id: string;
  mediaType: string;
  name: string;
}

const pageCount = async (bytes: Uint8Array) => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
};

const ask = async (
  orgId: string,
  data: Uint8Array,
  mediaType: string,
  pages: number
) => {
  try {
    const { output, usage, finalStep } = await generateText({
      model: models.chat,
      output: Output.object({ schema: drawingAnswerSchema }),
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data, mediaType },
            {
              type: "text",
              text: `${READ_DRAWING}\nThis file has ${pages} page${pages === 1 ? "" : "s"}.`,
            },
          ],
        },
      ],
    });
    await recordUsage(orgId, "drawing_read", finalStep.response.modelId, usage);
    return output;
  } catch (error) {
    await recordFailedUsage(orgId, "drawing_read", error);
    throw error;
  }
};

/** The most common stated unit across page groups. */
const unitsOf = (answers: { units: string }[]): DrawingReading["units"] => {
  const counts = { in: 0, mm: 0 };
  for (const a of answers) {
    if (a.units === "in" || a.units === "mm") {
      counts[a.units] += 1;
    }
  }
  if (counts.in === 0 && counts.mm === 0) {
    return null;
  }
  return counts.mm > counts.in ? "mm" : "in";
};

/**
 * Read one drawing file: one reading per part number on it, without flags
 * (those need the RFQ line and the shop; see readDrawings).
 */
export const readDrawing = async (
  orgId: string,
  file: DrawingFile
): Promise<DrawingReading[]> => {
  const isPdf = file.mediaType === "application/pdf";
  const sheets = isPdf ? Math.min(await pageCount(file.data), MAX_SHEETS) : 1;
  const groups = isPdf
    ? inGroups(
        Array.from({ length: sheets }, (_, i) => i + 1),
        SHEETS_PER_CALL
      )
    : [[1]];
  const answers: {
    firstSheet: number;
    answer: Awaited<ReturnType<typeof ask>>;
  }[] = [];
  for (const batch of inGroups(groups, PARALLEL_CALLS)) {
    const done = await Promise.all(
      batch.map(async (group) => ({
        firstSheet: group[0],
        answer: await ask(
          orgId,
          isPdf ? await pdfPages(file.data, group) : file.data,
          file.mediaType,
          group.length
        ),
      }))
    );
    answers.push(...done);
  }
  const parts: PartReading[] = answers.flatMap(({ firstSheet, answer }) =>
    answer.parts.map((p) => cleanPart(p, { sheets, firstSheet }))
  );
  const units = unitsOf(answers.map((a) => a.answer));
  const readAt = new Date().toISOString();
  return mergeParts(parts).map((p) => ({
    ...p,
    fileId: file.id,
    fileName: file.name,
    readAt,
    sheets,
    units,
    flags: [],
    questions: [],
  }));
};

const inBatches = async <T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>
) => {
  const out: R[] = [];
  for (const batch of inGroups(items, size)) {
    out.push(...(await Promise.all(batch.map(run))));
  }
  return out;
};

/** The shop records and settings a drawing is checked against. */
const shopContext = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const [settings, machines, materials, parts, bought] = await Promise.all([
    quoteSettings(orgId),
    db.workCenter.findMany({
      select: { name: true, envelope: true, toleranceIn: true },
    }),
    db.material.findMany({ select: { id: true, name: true } }),
    db.part.findMany({ select: { id: true, partNo: true, rev: true } }),
    db.purchaseOrderLine.findMany({
      where: { materialId: { not: null } },
      distinct: ["materialId"],
      select: { materialId: true },
    }),
  ]);
  return {
    settings,
    machines,
    materials,
    parts,
    bought: new Set(bought.map((b) => b.materialId)),
  };
};

interface LineRow {
  finish: string | null;
  id: string;
  lineNo: number;
  materialId: string | null;
  materialText: string | null;
  partId: string | null;
  partNo: string | null;
  qtys: number[];
  rev: string | null;
  tolerances: string | null;
}

/** Flags, questions, matches and the line fields a reading fills. */
const finish = (
  reading: DrawingReading,
  line: LineRow | null,
  shop: Awaited<ReturnType<typeof shopContext>>
) => {
  const material = reading.material
    ? (matchMaterial(reading.material.text, shop.materials) ??
      (reading.material.grade
        ? matchMaterial(
            [reading.material.grade, reading.material.condition]
              .filter(Boolean)
              .join(" "),
            shop.materials
          )
        : null))
    : null;
  const drawnNo =
    reading.titleBlock.partNo?.value ?? reading.titleBlock.drawingNo?.value;
  const part = matchPart(
    drawnNo,
    reading.titleBlock.rev?.value ?? null,
    shop.parts
  ).part;
  const { flags, questions } = checkDrawing(reading, {
    certifications: shop.settings.certifications,
    outsideProcesses: shop.settings.outsideProcesses,
    shopToleranceIn: shop.settings.toleranceIn,
    machines: shop.machines,
    // A known material is one on the shop's list or on a purchase order.
    materialKnown: Boolean(
      material && (shop.bought.size === 0 || shop.bought.has(material.id))
    ),
    line,
  });
  return {
    reading: { ...reading, flags, questions },
    materialId: material?.id ?? null,
    partId: part?.id ?? null,
  };
};

/**
 * Read every drawing on an RFQ and put what was read on its lines: matched
 * by part number, new lines for parts the RFQ text didn't list, empty fields
 * filled, differences flagged. Never throws: the RFQ stays usable without.
 */
export const readDrawings = async (orgId: string, rfqId: string) => {
  try {
    const db = forOrg(database, orgId);
    const files = await db.rfqFile.findMany({
      where: { rfqId, kind: { in: ["drawing", "model"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, kind: true, mediaType: true },
    });
    const drawings = files.filter((f) => f.kind === "drawing");
    const models3d = files.filter((f) => f.kind === "model");
    if (files.length === 0) {
      return;
    }
    const lines: LineRow[] = await db.rfqLine.findMany({
      where: { rfqId },
      orderBy: { lineNo: "asc" },
      select: {
        id: true,
        lineNo: true,
        partNo: true,
        rev: true,
        materialText: true,
        finish: true,
        tolerances: true,
        partId: true,
        materialId: true,
        qtys: true,
      },
    });
    const readAt = new Date().toISOString();

    // A 3D model and no drawing: nothing to read, ask for one.
    if (drawings.length === 0) {
      for (const line of lines) {
        await db.rfqLine.updateMany({
          where: { id: line.id },
          data: {
            drawing: noDrawingReading(
              models3d[0],
              line.partNo,
              readAt
            ) as object,
            fileId: models3d[0].id,
          },
        });
      }
      return;
    }

    const paused = await budgetProblem(orgId);
    if (paused) {
      log.info("Drawings not read: AI budget reached", { orgId, rfqId });
      return;
    }
    const read = await inBatches(drawings, PARALLEL_FILES, async (f) => {
      const row = await db.rfqFile.findFirst({
        where: { id: f.id },
        select: { data: true },
      });
      if (!row) {
        return [];
      }
      try {
        return await readDrawing(orgId, {
          id: f.id,
          name: f.name,
          mediaType: f.mediaType,
          data: new Uint8Array(row.data),
        });
      } catch (error) {
        log.warn("Reading a drawing failed", {
          orgId,
          rfqId,
          error: String(error),
        });
        return [];
      }
    });
    const parts = read.flat();
    if (parts.length === 0) {
      return;
    }
    const shop = await shopContext(orgId);
    const { update, create } = assignParts(lines, parts);

    for (const line of lines) {
      const reading = update.get(line.id);
      if (!reading) {
        continue;
      }
      const done = finish(reading, line, shop);
      await db.rfqLine.updateMany({
        where: { id: line.id },
        data: {
          ...linePatch(line, done.reading),
          drawing: done.reading as object,
          fileId: done.reading.fileId,
          partId: line.partId ?? done.partId,
          materialId: line.materialId ?? done.materialId,
        },
      });
    }

    let lineNo = Math.max(0, ...lines.map((l) => l.lineNo));
    for (const reading of create) {
      lineNo += 1;
      const done = finish(reading, null, shop);
      const qtys = [
        ...new Set(reading.quantities.map((q) => q.value).filter((q) => q > 0)),
      ]
        .sort((a, b) => a - b)
        .slice(0, MAX_QTY_BREAKS);
      const empty = {
        partNo: null,
        rev: null,
        materialText: null,
        finish: null,
        tolerances: null,
      };
      await db.rfqLine.create({
        data: {
          orgId,
          rfqId,
          lineNo,
          ...linePatch(empty, done.reading),
          description:
            reading.titleBlock.title?.value ??
            `Found on drawing ${reading.fileName}`,
          notes: `Found on the drawing ${reading.fileName}; the RFQ text didn't list it.`,
          qtys,
          drawing: done.reading as object,
          fileId: done.reading.fileId,
          partId: done.partId,
          materialId: done.materialId,
        },
      });
    }
  } catch (error) {
    log.warn("Reading an RFQ's drawings failed", {
      orgId,
      rfqId,
      error: String(error),
    });
  }
};
