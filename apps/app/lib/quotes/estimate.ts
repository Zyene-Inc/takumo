import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import type { OutsideProcess } from "@repo/engine-client";
import { isoDay } from "../schedule/request";
import {
  actualJobs,
  type EstimateResult,
  loadQuoteHistory,
  runEstimate,
} from "./estimate-engine";
import {
  engineMaterial,
  finishResponse,
  lineWarnings,
  MATERIAL_SELECT,
  operationsFor,
  planMaterial,
  quoteMaterial,
} from "./estimate-inputs";
import {
  buildUp,
  operationBasis,
  outsideDays,
  outsideProcesses,
  readDrawing,
} from "./pricing";
import { withActuals } from "./routing";
import { quoteSettings } from "./settings";
import type { LineDraft } from "./types";

export { loadQuoteHistory } from "./estimate-engine";

type LineEstimate =
  | { ok: true; draft: LineDraft }
  | { ok: false; error: string };

/**
 * Draft one RFQ line: work out its operations (the part's routing, or a
 * proposal for a new part), price its material, outside processes and
 * margin with the shop's own costs, run the estimate, and save it with a
 * build-up of where every number came from.
 */
export const estimateLine = async (
  orgId: string,
  lineId: string,
  today: string,
  history?: Awaited<ReturnType<typeof loadQuoteHistory>>
): Promise<LineEstimate> => {
  const db = forOrg(database, orgId);
  const line = await db.rfqLine.findFirst({
    where: { id: lineId },
    include: {
      rfq: {
        select: {
          id: true,
          customerName: true,
          requestedDate: true,
          customer: { select: { name: true, marginFloor: true } },
        },
      },
      part: {
        select: {
          id: true,
          partNo: true,
          material: { select: MATERIAL_SELECT },
        },
      },
      material: { select: MATERIAL_SELECT },
    },
  });
  if (!line) {
    return { ok: false, error: "That RFQ line no longer exists." };
  }
  if (line.qtys.length === 0) {
    return { ok: false, error: `Line ${line.lineNo} has no quantity.` };
  }
  const [shop, settings] = await Promise.all([
    history ?? loadQuoteHistory(orgId),
    quoteSettings(orgId),
  ]);
  const laborRateSet = await db.shopSettings
    .findFirst({ select: { laborRate: true } })
    .then((r) => r?.laborRate != null);
  const material = line.material ?? line.part?.material ?? null;
  const customer = line.rfq.customer?.name ?? line.rfq.customerName ?? null;
  const partNo = line.part?.partNo ?? line.partNo ?? `Line ${line.lineNo}`;
  const drawing = readDrawing(line.drawing);
  const requestedDate = line.rfq.requestedDate
    ? isoDay(line.rfq.requestedDate)
    : null;

  const operations = await operationsFor(orgId, line, shop, {
    customer,
    materialName: material?.name ?? line.materialText,
  });
  if (!operations.ok) {
    return operations;
  }
  const { routing, routingNotes, facts } = operations;

  const { pricing, waits } = await planMaterial(orgId, {
    line,
    material,
    drawing,
    markup: settings.materialMarkup,
    today,
  });

  const stations = await db.workCenter.findMany({
    select: { name: true, type: true },
  });
  const outside = outsideProcesses({
    saved: line.outside as OutsideProcess[] | null,
    drawingFinishes: drawing?.finishes ?? [],
    lineFinish: line.finish,
    stations: stations.flatMap((w) => [w.name, w.type ?? ""]),
    suppliers: settings.outsideProcesses,
  });
  const extraDays = outsideDays(outside.meta);

  const result = await runEstimate(
    orgId,
    {
      partNo,
      newPart: !line.part,
      customer,
      material: engineMaterial(pricing, material, line),
      routing,
      qtys: line.qtys,
      outside: outside.outside,
      targetMargin: line.targetMargin,
      defaultMargin: settings.defaultMargin,
      requestedDate,
      today,
    },
    shop,
    true,
    {
      laborRate: settings.laborRate,
      materialWaits: material
        ? new Map([...waits].map(([q, w]) => [q, w.days]))
        : undefined,
    }
  );
  if (!result.ok) {
    return result;
  }
  const floor = line.rfq.customer?.marginFloor ?? null;
  const finished = finishResponse(result.response, {
    customer,
    floor,
    material: pricing,
    outsideDays: extraDays,
    requestedDate,
  });
  finished.response.warnings.push(
    ...lineWarnings(outside.meta, routing, { ...facts, partNo })
  );
  const draft: LineDraft = {
    estimatedAt: new Date().toISOString(),
    inputs: result.inputs,
    routingNotes,
    response: finished.response,
    buildUp: buildUp(finished.response, {
      routing,
      material: pricing,
      materialWaits: waits,
      outside: outside.meta,
      outsideDays: extraDays,
      floor,
      floorRaised: finished.raised,
      targetMargin: line.targetMargin,
      laborRate: { rate: settings.laborRate, set: laborRateSet },
      machines: shop.rates,
      opBasis: new Map(
        routing.map((op) => [op.seq, operationBasis(op, { ...facts, partNo })])
      ),
    }),
  };
  // A line that's been quoted keeps the numbers that were sent.
  const saved = await db.rfqLine.updateMany({
    where: { id: line.id, quoteId: null },
    data: {
      draft: draft as object,
      ...(material && !line.materialId ? { materialId: material.id } : {}),
      // New numbers: the estimator's edits to the old ones no longer apply.
      final: Prisma.DbNull,
    },
  });
  if (saved.count === 0) {
    return { ok: false, error: `Line ${line.lineNo} has already been quoted.` };
  }
  return { ok: true, draft };
};

/**
 * Price a part the shop makes, outside any RFQ (Ask Takumo): its routing with
 * actual times, its material, and the quote history.
 */
export const estimateForPart = async (
  orgId: string,
  partId: string,
  options: {
    customer: string | null;
    qtys: number[];
    requestedDate: string | null;
    targetMargin: number | null;
    today: string;
  }
): Promise<EstimateResult> => {
  const [shop, settings] = await Promise.all([
    loadQuoteHistory(orgId),
    quoteSettings(orgId),
  ]);
  const part = shop.candidates.find((c) => c.id === partId);
  if (!part) {
    return { ok: false, error: "That part no longer exists." };
  }
  const record = await forOrg(database, orgId).part.findFirst({
    where: { id: partId },
    select: {
      material: {
        select: { name: true, unit: true, unitCost: true, leadTimeDays: true },
      },
    },
  });
  return runEstimate(
    orgId,
    {
      partNo: part.partNo,
      newPart: false,
      customer: options.customer,
      material: quoteMaterial(record?.material ?? null, {
        materialCost: null,
        materialText: null,
        usagePerPart: null,
      }),
      routing: withActuals(part.routing, await actualJobs(orgId, part.id)),
      qtys: options.qtys,
      outside: [],
      targetMargin: options.targetMargin,
      defaultMargin: settings.defaultMargin,
      requestedDate: options.requestedDate,
      today: options.today,
    },
    shop,
    true,
    { laborRate: settings.laborRate }
  );
};
