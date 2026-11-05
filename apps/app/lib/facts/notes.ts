import "server-only";

import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { recordFailedUsage, recordUsage } from "../ai-usage";
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

const SOURCES = {
  note: {
    what: "notes from a machine shop's floor (operators' voice notes, supervisors' typed notes)",
    noun: "note",
  },
  document: {
    what: "a machine shop's documents (setup sheets, SOPs, quality manuals, customer specs, travelers, inspection reports)",
    noun: "document",
  },
} as const;

const system = (kind: keyof typeof SOURCES) => {
  const { what, noun } = SOURCES[kind];
  return `You turn ${what} into facts for the shop's model.

Rules:
- Only record what the ${noun} states as true about this shop. Skip greetings, guesses ("maybe", "I think it could"), questions and one-off events that aren't knowledge (a single late delivery).
- A corrected number is a fact about a model parameter: "setup on the HAAS for P-1001 is really 2 hours" → subjectType routing, the matching part and op, attribute setupMin, value 120. Convert to minutes, fractions or dollars as the attribute needs.
- Knowledge in words is a note: "P-2001 chatters above 1,200 rpm, run it at 1,000" → subjectType part (or routing), attribute note, value: one clear sentence in the shop's terms.
- A customer's requirement is a note on that customer (or on the part when it names one): "all Cobalt Medical parts need a first-article inspection report" → subjectType customer, attribute note.
- Identify subjects only from the shop's lists below. If the ${noun} names a machine, pick the operation of that part that runs on it. If you can't tell which part, operation or machine, skip the fact.
- quote: the exact words from the ${noun}, so a supervisor can check it.
- An empty list is fine.

Attributes by subject type:
${attributeList()}`;
};

/** The shop's records in a form the model can match words against. */
export const shopContext = async (orgId: string) => {
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

export const extractFacts = async (
  orgId: string,
  text: string,
  {
    kind = "note",
    context,
  }: {
    kind?: keyof typeof SOURCES;
    /** The shop's lists, when the caller already loaded them. */
    context?: string;
  } = {}
) => {
  const feature = kind === "note" ? "note_read" : "doc_read";
  try {
    const { output, usage, finalStep } = await generateText({
      // Floor notes are short and every word counts; documents are long and
      // read in pieces, so the faster model keeps them affordable.
      model: kind === "note" ? models.agent : models.chat,
      output: Output.object({ schema }),
      instructions: system(kind),
      prompt: `${context ?? (await shopContext(orgId))}

${SOURCES[kind].noun[0].toUpperCase()}${SOURCES[kind].noun.slice(1)}:
<${SOURCES[kind].noun}>
${text.slice(0, MAX_NOTE_CHARS)}
</${SOURCES[kind].noun}>`,
    });
    await recordUsage(orgId, feature, finalStep.response.modelId, usage);
    return output?.facts ?? [];
  } catch (error) {
    await recordFailedUsage(orgId, feature, error);
    throw error;
  }
};

export interface NoteResult {
  noteId: string;
  /** Facts proposed from the note, e.g. ["F-12"]. */
  proposed: string[];
  /** Facts the model saw that couldn't be recorded, with the reason. */
  skipped: string[];
}

/** Read a saved note and propose the facts in it for review. */
const readNote = async (
  orgId: string,
  noteId: string,
  note: {
    kind: string;
    text: string;
    statedBy: string | null;
    source?: FactSource;
  }
): Promise<NoteResult> => {
  const db = forOrg(database, orgId);
  const result: NoteResult = { noteId, proposed: [], skipped: [] };
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
        statedBy: note.statedBy,
        noteId,
      });
      if (made.ok) {
        result.proposed.push(made.fact.label);
      } else {
        result.skipped.push(`"${fact.quote}": ${made.error}`);
      }
    }
    await db.note.updateMany({
      where: { id: noteId },
      data: { status: "done", error: null },
    });
  } catch (error) {
    log.warn("Reading a note failed", { error: String(error) });
    await db.note.updateMany({
      where: { id: noteId },
      data: {
        status: "failed",
        error:
          "Takumo couldn't read this note just now. It's saved; try again later.",
      },
    });
  }
  return result;
};

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
    /** Sent by text message (F6.1): "sms" or "whatsapp", and from whom. */
    channel?: "sms" | "whatsapp" | null;
    senderName?: string | null;
    /** Why the note can't be read now (plan or AI budget): saved as failed. */
    paused?: string | null;
  }
): Promise<NoteResult> => {
  const saved = await forOrg(database, orgId).note.create({
    data: {
      orgId,
      kind: note.kind,
      text: note.text.trim().slice(0, MAX_NOTE_CHARS),
      durationSec: note.durationSec ?? null,
      jobId: note.jobId ?? null,
      createdBy: userId,
      channel: note.channel ?? null,
      senderName: note.senderName?.slice(0, 120) ?? null,
      ...(note.paused ? { status: "failed", error: note.paused } : {}),
    },
    select: { id: true },
  });
  if (note.paused) {
    return { noteId: saved.id, proposed: [], skipped: [] };
  }
  return readNote(orgId, saved.id, { ...note, statedBy: userId });
};

/**
 * Read a note again after a failure. The note itself (text, author, date)
 * stays as it was; null when there's no failed note to retry.
 */
export const rereadNote = async (orgId: string, noteId: string) => {
  const db = forOrg(database, orgId);
  const note = await db.note.findFirst({ where: { id: noteId } });
  if (!note) {
    return null;
  }
  // Claim it, so two clicks don't read it twice.
  const claimed = await db.note.updateMany({
    where: { id: noteId, status: "failed" },
    data: { status: "reading", error: null },
  });
  if (claimed.count === 0) {
    return null;
  }
  return readNote(orgId, noteId, {
    kind: note.kind,
    text: note.text,
    statedBy: note.createdBy,
  });
};
