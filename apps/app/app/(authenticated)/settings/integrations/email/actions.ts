"use server";

import { database, forOrg } from "@repo/database";
import {
  type ColumnMapping,
  ENTITY_KEYS,
  type EntityKey,
  suggestMapping,
} from "@repo/ingest";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/access";
import {
  confirmReport,
  REPORT_MODES,
  type ReportResult,
} from "@/lib/erp/reports";
import { ensureAddresses } from "@/lib/inbound/process";
import { emailAddress, INBOUND_KINDS, newToken } from "@/lib/inbound/verify";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const PATH = "/settings/integrations/email";
const SPLIT = /[\s,;]+/;
const DOMAIN_RULE = /^@?[a-z0-9.-]+\.[a-z]{2,}$/;

/** "reports@shop.com, @shop.com" → each entry checked and normalised. */
const parseSenders = (text: string) => {
  const entries = text
    .split(SPLIT)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = entries.filter(
    (e) => !(emailAddress(e) === e || DOMAIN_RULE.test(e))
  );
  return { entries: [...new Set(entries)], bad };
};

export const saveSenders = async (input: {
  kind: string;
  text: string;
}): Promise<Result> => {
  const access = await authorize("connectors:manage");
  if (!access.ok) {
    return access;
  }
  if (!(INBOUND_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, error: "Unknown address." };
  }
  const { entries, bad } = parseSenders(input.text);
  if (bad.length) {
    return {
      ok: false,
      error: `Not an email address or domain: ${bad.slice(0, 3).join(", ")}`,
    };
  }
  await ensureAddresses(access.orgId);
  await forOrg(database, access.orgId).inboundAddress.updateMany({
    where: { kind: input.kind },
    data: { allowedSenders: entries },
  });
  revalidatePath(PATH);
  return { ok: true };
};

/** A new address; the old one stops working at once. */
export const rotateAddress = async (kind: string): Promise<Result> => {
  const access = await authorize("connectors:manage");
  if (!access.ok) {
    return access;
  }
  if (!(INBOUND_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: "Unknown address." };
  }
  await ensureAddresses(access.orgId);
  await forOrg(database, access.orgId).inboundAddress.updateMany({
    where: { kind },
    data: { token: newToken(), rotatedAt: new Date() },
  });
  revalidatePath(PATH);
  return { ok: true };
};

/** The offline column suggestion when an admin changes what a report holds. */
export const suggestForEntity = async (
  reportId: string,
  entity: string
): Promise<Result<{ mapping: ColumnMapping }>> => {
  const access = await authorize("connectors:manage");
  if (!access.ok) {
    return access;
  }
  if (!(ENTITY_KEYS as readonly string[]).includes(entity)) {
    return { ok: false, error: "Unknown data type." };
  }
  const report = await forOrg(database, access.orgId).erpReport.findFirst({
    where: { id: reportId },
    select: { headers: true },
  });
  if (!report) {
    return { ok: false, error: "That report no longer exists." };
  }
  return {
    ok: true,
    mapping: suggestMapping(entity as EntityKey, report.headers),
  };
};

const mappingSchema = z.object({
  entity: z.enum(ENTITY_KEYS),
  columns: z.record(z.string(), z.string().nullable()),
  timeUnits: z.record(z.string(), z.enum(["minutes", "hours"])),
});

export const confirmMapping = async (input: {
  reportId: string;
  mapping: unknown;
  mode: string;
}): Promise<Result<{ result: ReportResult | null }>> => {
  const access = await authorize("connectors:manage");
  if (!access.ok) {
    return access;
  }
  const parsed = mappingSchema.safeParse(input.mapping);
  const mode = REPORT_MODES.find((m) => m === input.mode);
  if (!(parsed.success && mode)) {
    return { ok: false, error: "Check the columns and try again." };
  }
  const mapping: ColumnMapping = {
    ...parsed.data,
    confidence: {},
    source: "heuristic",
  };
  const done = await confirmReport(access.orgId, input.reportId, mapping, mode);
  revalidatePath(PATH);
  return done.ok ? { ok: true, result: done.result } : done;
};

export const setReportStatus = async (
  reportId: string,
  status: "active" | "paused"
): Promise<Result> => {
  const access = await authorize("connectors:manage");
  if (!access.ok) {
    return access;
  }
  const db = forOrg(database, access.orgId);
  const report = await db.erpReport.findFirst({
    where: { id: reportId },
    select: { mapping: true },
  });
  if (!report) {
    return { ok: false, error: "That report no longer exists." };
  }
  if (status === "active" && !report.mapping) {
    return { ok: false, error: "Confirm its columns first." };
  }
  await db.erpReport.updateMany({ where: { id: reportId }, data: { status } });
  revalidatePath(PATH);
  return { ok: true };
};

export const forgetReport = async (reportId: string): Promise<Result> => {
  const access = await authorize("connectors:manage");
  if (!access.ok) {
    return access;
  }
  await forOrg(database, access.orgId).erpReport.deleteMany({
    where: { id: reportId },
  });
  revalidatePath(PATH);
  return { ok: true };
};
