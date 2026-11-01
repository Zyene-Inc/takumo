// Match what a document calls things ("P2001 rev C", "the HAAS VF-2") to the
// shop's own records. Exact after normalising first, then a unique partial
// match; anything ambiguous stays unmatched rather than guessed. Pure, so
// tested.

export const MENTION_TYPES = [
  "part",
  "machine",
  "customer",
  "material",
] as const;
export type MentionType = (typeof MENTION_TYPES)[number];

export interface CatalogEntry {
  id: string;
  /** Normalised names the record answers to. */
  keys: string[];
  label: string;
  /** For parts: the revision, to prefer the one a document names. */
  rev?: string | null;
  type: MentionType;
}

export interface Resolved {
  /** How it matched: exact (normalised) or a unique partial match. */
  how: "exact" | "partial";
  id: string;
  label: string;
  type: MentionType;
}

const NON_ALNUM = /[^A-Z0-9]/g;
const REV = /\s*\b(?:REV(?:ISION)?\.?|R)\s*[:#-]?\s*([A-Z0-9]{1,3})\s*$/i;
const LEADING_THE = /^(?:THE|OUR)\s+/i;
// Short names ("A1", "HA") would match by accident: a mention needs 3
// characters to be found inside a record's name ("VF2" in HAAS-VF2), a
// record's name 4 to be found inside a mention.
const MIN_MENTION = 3;
const MIN_RECORD = 4;

export const normalize = (name: string) =>
  name.toUpperCase().replace(NON_ALNUM, "");

/** "P2001 rev C" → { name: "P2001", rev: "C" }. */
export const splitRev = (name: string) => {
  const m = name.match(REV);
  return m?.index && m.index > 0
    ? { name: name.slice(0, m.index), rev: m[1].toUpperCase() }
    : { name, rev: null };
};

const pickPart = (entries: CatalogEntry[], rev: string | null) =>
  entries.find((e) => rev && e.rev?.toUpperCase() === rev) ?? entries[0];

const unique = (entries: CatalogEntry[]) => {
  const ids = new Set(
    entries.map((e) => (e.type === "part" ? e.label.split(" rev ")[0] : e.id))
  );
  return ids.size === 1 ? entries : [];
};

export const resolveMention = (
  mention: { name: string; type: MentionType },
  catalog: CatalogEntry[]
): Resolved | null => {
  const ofType = catalog.filter((e) => e.type === mention.type);
  const { name, rev } =
    mention.type === "part"
      ? splitRev(mention.name)
      : { name: mention.name, rev: null };
  const key = normalize(name.replace(LEADING_THE, ""));
  if (!key) {
    return null;
  }
  const done = (entries: CatalogEntry[], how: Resolved["how"]) => {
    const e = mention.type === "part" ? pickPart(entries, rev) : entries[0];
    return { id: e.id, label: e.label, type: e.type, how };
  };
  const exact = ofType.filter((e) => e.keys.includes(key));
  if (exact.length) {
    return done(exact, "exact");
  }
  if (key.length < MIN_MENTION) {
    return null;
  }
  const partial = unique(
    ofType.filter((e) =>
      e.keys.some(
        (k) => k.includes(key) || (k.length >= MIN_RECORD && key.includes(k))
      )
    )
  );
  return partial.length ? done(partial, "partial") : null;
};
