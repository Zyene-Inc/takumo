import "server-only";

import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { ATTRIBUTES, SUBJECT_TYPES } from "./attributes";
import { type FactSource, findSubject, proposeFact } from "./facts";

const MAX_NOTE_CHARS = 8000;

const factSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  partNo: z
    .string()
    .nullable()
    .describe(
      "For an operation or part: the part number, exactly as in the shop's list"
    ),
  rev: z.string().nullable(),
  seq: z.number().int().nullable().describe("For an operation: its op number"),
  name: z
    .string()
    .nullable()
    .describe(
      "For a machine, material or customer: its name from the shop's list"
    ),
  attribute: z
    .string()
    .describe("One of the attributes listed for the subject type"),
  value: z
    .union([z.number(), z.string()])
    .describe(
      "Minutes for times (2 hrs → 120), a fraction for efficiency (92% → 0.92), words for a note"
    ),
  quote: z
    .string()
    .describe("The speaker's own words this fact comes from, verbatim"),
});

const schema = z.object({ facts: z.array(factSchema) });

export type NoteFact = z.infer<typeof factSchema>;

const attributeList = () =>
  Object.entries(ATTRIBUTES)
    .map(
      ([type, defs]) =>
        `- ${type}: ${defs.map((d) => `${d.key} (${d.label}${d.unit ? `, ${d.unit}` : ""}${d.percent ? ", fraction" : ""})`).join(", ")}`
    )
    .join("\n");

const SYSTEM = `You turn notes from a machine shop's floor (operators' voice notes, supervisors' typed notes) into facts for the shop's model.

Rules:
- Only record what the note states as true about this shop. Skip greetings, guesses ("maybe", "I think it could"), questions and one-off events that aren't knowledge (a single late delivery).
- A corrected number is a fact about a model parameter: "setup on the HAAS for P-1001 is really 2 hours" → subjectType routing, the matching part and op, attribute setupMin, value 120. Convert to minutes, fractions or dollars as the attribute needs.
- Knowledge in words is a note: "P-2001 chatters above 1,200 rpm, run it at 1,000" → subjectType part (or routing), attribute note, value: one clear sentence in the shop's terms.
- Identify subjects only from the shop's lists below. If the note names a machine, pick the operation of that part that runs on it. If you can't tell which part, operation or machine, skip the fact.
- quote: the exact words from the note, so a supervisor can check it.
- An empty list is fine.

Attributes by subject type:
${attributeList()}`;

/** The shop's records in a form the model can match words against. */
const shopContext = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const [machines, routings, materials, customers] = await Promise.all([
    db.workCenter.findMany({
      orderBy: { name: "asc" },
      select: { name: true, type: true },
    }),
    db.routing.findMany({
      orderBy: [{ part: { partNo: "asc" } }, { seq: "asc" }],
      take: 1500,
      select: {
        seq: true,
        setupMin: true,
        runMinPerUnit: true,
        part: { select: { partNo: true, rev: true, description: true } },
        workCenter: { select: { name: true } },
      },
    }),
    db.material.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
    db.customer.findMany({ orderBy: { name: "asc" }, select: { name: true } }),
  ]);
  return `Machines: ${machines.map((m) => `${m.name}${m.type ? ` (${m.type})` : ""}`).join(", ")}
Operations (part rev: op machine, setup min, run min/part):
${routings.map((r) => `- ${r.part.partNo} rev ${r.part.rev}${r.part.description ? ` "${r.part.description}"` : ""}: op ${r.seq} ${r.workCenter.name}, ${r.setupMin} min, ${r.runMinPerUnit} min/part`).join("\n")}
Materials: ${materials.map((m) => m.name).join(", ")}
Customers: ${customers.map((c) => c.name).join(", ")}`;
};

export const extractFacts = async (orgId: string, text: string) => {
  const { output } = await generateText({
    model: models.agent,
    output: Output.object({ schema }),
    system: SYSTEM,
    prompt: `${await shopContext(orgId)}

Note:
<note>
${text.slice(0, MAX_NOTE_CHARS)}
</note>`,
  });
  return output?.facts ?? [];
};

export interface NoteResult {
  noteId: string;
  /** Facts proposed from the note, e.g. ["F-12"]. */
  proposed: string[];
  /** Facts the model saw that couldn't be recorded, with the reason. */
  skipped: string[];
}

/**
 * Save a note and propose the facts in it for review. The note is kept even
 * when nothing in it is a fact.
 */
export const saveNote = async (
  orgId: string,
  userId: string | null,
  note: {
    kind: "voice" | "typed";
    text: string;
    durationSec?: number | null;
    jobId?: string | null;
    source?: FactSource;
  }
): Promise<NoteResult> => {
  const db = forOrg(database, orgId);
  const saved = await db.note.create({
    data: {
      orgId,
      kind: note.kind,
      text: note.text.trim().slice(0, MAX_NOTE_CHARS),
      durationSec: note.durationSec ?? null,
      jobId: note.jobId ?? null,
      createdBy: userId,
    },
    select: { id: true },
  });
  const result: NoteResult = { noteId: saved.id, proposed: [], skipped: [] };
  try {
    const facts = await extractFacts(orgId, note.text);
    for (const fact of facts) {
      const found = await findSubject(orgId, fact.subjectType, {
        partNo: fact.partNo,
        rev: fact.rev,
        seq: fact.seq,
        name: fact.name,
      });
      if (!found.ok) {
        result.skipped.push(`"${fact.quote}": ${found.error}`);
        continue;
      }
      const made = await proposeFact(orgId, {
        subject: found.subject,
        attribute: fact.attribute,
        value: fact.value,
        evidence: `"${fact.quote}"`,
        source: note.source ?? (note.kind === "voice" ? "voice" : "note"),
        statedBy: userId,
        noteId: saved.id,
      });
      if (made.ok) {
        result.proposed.push(made.fact.label);
      } else {
        result.skipped.push(`"${fact.quote}": ${made.error}`);
      }
    }
    await db.note.updateMany({
      where: { id: saved.id },
      data: { status: "done" },
    });
  } catch (error) {
    log.warn("Reading a note failed", { error: String(error) });
    await db.note.updateMany({
      where: { id: saved.id },
      data: {
        status: "failed",
        error:
          "Takumo couldn't read this note just now. It's saved; try again later.",
      },
    });
  }
  return result;
};

/** Read a saved note again (after a failure). */
export const rereadNote = async (
  orgId: string,
  noteId: string,
  userId: string | null
) => {
  const db = forOrg(database, orgId);
  const note = await db.note.findFirst({ where: { id: noteId } });
  if (!note) {
    return null;
  }
  await db.note.deleteMany({ where: { id: noteId } });
  return saveNote(orgId, userId, {
    kind: note.kind === "voice" ? "voice" : "typed",
    text: note.text,
    durationSec: note.durationSec,
    jobId: note.jobId,
  });
};
