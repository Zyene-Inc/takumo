import {
  ENTITIES,
  ENTITY_KEYS,
  type EntityKey,
  type FieldDef,
} from "./entities";

export type TimeUnit = "minutes" | "hours";

// Which file column feeds each Takumo field. Built by the matcher or the AI,
// then confirmed (and possibly changed) by the user before anything is saved.
export interface ColumnMapping {
  readonly columns: Readonly<Record<string, string | null>>;
  // How confident the suggestion was, 0–1, per field. Shown in the UI.
  readonly confidence: Readonly<Record<string, number>>;
  readonly entity: EntityKey;
  readonly notes?: readonly string[];
  readonly source: "heuristic" | "ai";
  // For "minutes" fields: whether the column holds minutes or hours.
  readonly timeUnits: Readonly<Record<string, TimeUnit>>;
}

const MIN_SCORE = 0.6;
const HOURS = /\b(hr|hrs|hour|hours)\b/;

export const normalizeHeader = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_\-./#()[\]:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const candidates = (field: FieldDef) =>
  [field.key, field.label, ...field.synonyms].map(normalizeHeader);

const containsWords = (haystack: string, needle: string) =>
  ` ${haystack} `.includes(` ${needle} `);

const scoreHeader = (header: string, field: FieldDef) => {
  const h = normalizeHeader(header);
  if (!h) {
    return 0;
  }
  let best = 0;
  for (const c of candidates(field)) {
    if (h === c) {
      return 1;
    }
    if (containsWords(h, c) || containsWords(c, h)) {
      // "Setup Time (hrs)" vs "setup time": close, weighted by overlap.
      const ratio = Math.min(h.length, c.length) / Math.max(h.length, c.length);
      best = Math.max(best, 0.6 + 0.35 * ratio);
    }
  }
  return best;
};

const looksLikeHours = (header: string) => HOURS.test(normalizeHeader(header));

/** Matches file headers to an entity's fields by name. Works offline. */
export const suggestMapping = (
  entity: EntityKey,
  headers: readonly string[]
): ColumnMapping => {
  const fields = ENTITIES[entity].fields;
  const pairs: { field: string; header: string; score: number }[] = [];
  for (const field of fields) {
    for (const header of headers) {
      const score = scoreHeader(header, field);
      if (score >= MIN_SCORE) {
        pairs.push({ field: field.key, header, score });
      }
    }
  }
  // Best pairs first; each field and each header is used once.
  pairs.sort((a, b) => b.score - a.score);
  const columns: Record<string, string | null> = {};
  const confidence: Record<string, number> = {};
  const usedHeaders = new Set<string>();
  for (const pair of pairs) {
    if (pair.field in columns || usedHeaders.has(pair.header)) {
      continue;
    }
    columns[pair.field] = pair.header;
    confidence[pair.field] = Number(pair.score.toFixed(2));
    usedHeaders.add(pair.header);
  }

  const timeUnits: Record<string, TimeUnit> = {};
  for (const field of fields) {
    columns[field.key] ??= null;
    confidence[field.key] ??= 0;
    if (field.kind === "minutes") {
      const header = columns[field.key];
      timeUnits[field.key] =
        header && looksLikeHours(header) ? "hours" : "minutes";
    }
  }

  return { entity, columns, confidence, timeUnits, source: "heuristic" };
};

/** Share of an entity's fields found in the headers; required fields count double. */
export const entityScore = (entity: EntityKey, headers: readonly string[]) => {
  const mapping = suggestMapping(entity, headers);
  let total = 0;
  let matched = 0;
  for (const field of ENTITIES[entity].fields) {
    const weight = field.required ? 2 : 1;
    total += weight;
    if (mapping.columns[field.key]) {
      matched += weight * (mapping.confidence[field.key] ?? 0);
    }
  }
  return total === 0 ? 0 : matched / total;
};

/** Guesses what kind of sheet this is from its headers. */
export const detectEntity = (headers: readonly string[]): EntityKey => {
  let best: EntityKey = ENTITY_KEYS[0];
  let bestScore = -1;
  for (const key of ENTITY_KEYS) {
    const score = entityScore(key, headers);
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
};

export const missingRequired = (mapping: ColumnMapping) =>
  ENTITIES[mapping.entity].fields
    .filter((f) => f.required && !mapping.columns[f.key])
    .map((f) => f.label);
