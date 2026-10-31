import "server-only";

import {
  generateText,
  type LanguageModelUsage,
  NoObjectGeneratedError,
  Output,
} from "@repo/ai";
import { keys } from "@repo/ai/keys";
import { models } from "@repo/ai/lib/models";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { ENTITIES, ENTITY_KEYS, type EntityKey } from "./entities";
import {
  type ColumnMapping,
  detectEntity,
  suggestMapping,
  type TimeUnit,
} from "./match";
import type { SheetRow } from "./transform";

const SAMPLE_ROWS = 8;

const describeEntities = () =>
  ENTITY_KEYS.map((key) => {
    const e = ENTITIES[key];
    const fields = e.fields
      .map(
        (f) =>
          `    - ${f.key} (${f.kind}${f.required ? ", required" : ""}): ${f.label}${
            f.hint ? ` — ${f.hint}` : ""
          }${f.values ? ` [${f.values.join("|")}]` : ""}`
      )
      .join("\n");
    return `- ${key}: ${e.label}. ${e.description}\n${fields}`;
  }).join("\n");

const cellText = (value: unknown) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value ?? "");

const schema = z.object({
  entity: z.enum(ENTITY_KEYS),
  columns: z.array(
    z.object({
      field: z.string(),
      column: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      timeUnit: z.enum(["minutes", "hours"]).nullable(),
    })
  ),
  notes: z.array(z.string()),
});

type OnUsage = (modelId: string, usage: LanguageModelUsage) => Promise<void>;

/** A call whose answer couldn't be read was still billed: report it. */
const reportFailedUsage = async (error: unknown, onUsage?: OnUsage) => {
  if (onUsage && NoObjectGeneratedError.isInstance(error) && error.usage) {
    await onUsage(error.response?.modelId ?? "unknown", error.usage);
  }
};

/**
 * Asks Claude what kind of sheet this is and which column feeds each field.
 * Falls back to the offline matcher when no API key is set or the call fails,
 * so onboarding never blocks on the model.
 */
export const suggestMappingWithAi = async ({
  fileName,
  sheetName,
  headers,
  rows,
  entity,
  useAi = true,
  onUsage,
}: {
  fileName: string;
  sheetName?: string;
  headers: readonly string[];
  rows: readonly SheetRow[];
  // Set when the user already picked the sheet type.
  entity?: EntityKey;
  /** False when the shop's AI is paused (plan or budget): offline matcher only. */
  useAi?: boolean;
  /** Called with what the call used, so the app can count the spend. */
  onUsage?: OnUsage;
}): Promise<ColumnMapping> => {
  const fallback = suggestMapping(entity ?? detectEntity(headers), headers);
  if (!(useAi && keys().ANTHROPIC_API_KEY) || headers.length === 0) {
    return fallback;
  }

  const sample = rows
    .slice(0, SAMPLE_ROWS)
    .map((row) => headers.map((h) => cellText(row[h])).join(" | "))
    .join("\n");

  try {
    const { output, usage, response } = await generateText({
      model: models.extract,
      output: Output.object({ schema }),
      system: `You map spreadsheet columns from a manufacturing job shop (ERP exports, Excel trackers) to Takumo's data model.
Only use column names that appear exactly in the header list. Leave a field's column null when no column fits; never guess wildly.
For setup/run time fields, say whether the column holds minutes or hours, using the header and the sample values.
Confidence: 0.9+ when the header clearly names the field, 0.6–0.9 when you infer it from values, below 0.6 when unsure.
Takumo converts values itself: dates in any common format, currency and thousands separators, percentages, hours to minutes, and common status words (Released/Firm → open, WIP → in_progress, Closed/Shipped → done, Won/Lost/Sent for quotes). Don't write notes about those.
Notes: at most 3 short, plain-English remarks a shop owner should know (e.g. "Run time looks like hours, converted to minutes"). No notes if nothing stands out.

Data model:
${describeEntities()}`,
      prompt: `File: ${fileName}${sheetName ? ` (sheet "${sheetName}")` : ""}
${entity ? `The user says this sheet contains: ${entity}. Use that entity.\n` : ""}Headers: ${headers.join(" | ")}
First rows:
${sample}`,
    });

    await onUsage?.(response.modelId, usage);
    if (!output) {
      log.warn("AI column mapping returned no output", { fileName });
      return fallback;
    }

    const chosen = entity ?? output.entity;
    const known = new Set(headers);
    const offline = suggestMapping(chosen, headers);
    const columns: Record<string, string | null> = {};
    const confidence: Record<string, number> = {};
    const timeUnits: Record<string, TimeUnit> = {};
    for (const field of ENTITIES[chosen].fields) {
      const ai = output.columns.find((c) => c.field === field.key);
      if (ai?.column && known.has(ai.column)) {
        columns[field.key] = ai.column;
        confidence[field.key] = ai.confidence;
      } else {
        // Keep an exact header match the model skipped.
        columns[field.key] = offline.columns[field.key] ?? null;
        confidence[field.key] = offline.confidence[field.key] ?? 0;
      }
      if (field.kind === "minutes") {
        timeUnits[field.key] =
          ai?.timeUnit ?? offline.timeUnits[field.key] ?? "minutes";
      }
    }
    return {
      entity: chosen,
      columns,
      confidence,
      timeUnits,
      source: "ai",
      notes: output.notes.slice(0, 3),
    };
  } catch (error) {
    await reportFailedUsage(error, onUsage);
    log.warn("AI column mapping failed; using the offline matcher", {
      fileName,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
};
