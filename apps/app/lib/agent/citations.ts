// Citations: every tool result lists the records it drew on as sources, the
// agent cites them inline as [order SO-5001], and the UI turns each into a
// link to the record. A citation that no tool returned is shown as
// unverified. Pure (no server code), shared by the server and the chat UI.

export const SOURCE_KINDS = [
  "order",
  "part",
  "routing",
  "machine",
  "customer",
  "quote",
  "material",
  "doc",
  "plan",
  "check",
  "query",
  "scenario",
  "estimate",
  "fact",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface Source {
  /** A line of context: a document snippet, the question a query answered. */
  detail?: string;
  href?: string;
  /** What the agent writes inside the brackets, e.g. "order SO-5001". */
  id: string;
  kind: SourceKind;
  label: string;
  /** For query sources: the SQL that ran. */
  sql?: string;
}

const enc = encodeURIComponent;

export const cite = {
  order: (orderNo: string): Source => ({
    id: `order ${orderNo}`,
    kind: "order",
    label: orderNo,
    href: `/shop/orders?q=${enc(orderNo)}`,
  }),
  part: (partNo: string, partId?: string): Source => ({
    id: `part ${partNo}`,
    kind: "part",
    label: partNo,
    href: partId ? `/shop/parts/${partId}` : `/shop/parts?q=${enc(partNo)}`,
  }),
  routing: (partNo: string, seq: number, partId?: string): Source => ({
    id: `routing ${partNo} op ${seq}`,
    kind: "routing",
    label: `${partNo} op ${seq}`,
    href: partId ? `/shop/parts/${partId}` : `/shop/parts?q=${enc(partNo)}`,
  }),
  machine: (name: string): Source => ({
    id: `machine ${name}`,
    kind: "machine",
    label: name,
    href: `/shop/work-centers?q=${enc(name)}`,
  }),
  customer: (name: string): Source => ({
    id: `customer ${name}`,
    kind: "customer",
    label: name,
    href: `/shop/customers?q=${enc(name)}`,
  }),
  quote: (quoteNo: string): Source => ({
    id: `quote ${quoteNo}`,
    kind: "quote",
    label: quoteNo,
    href: `/quotes/history?q=${enc(quoteNo)}`,
  }),
  material: (name: string): Source => ({
    id: `material ${name}`,
    kind: "material",
    label: name,
    href: `/shop/materials?q=${enc(name)}`,
  }),
  doc: (
    sourceName: string,
    page: number | null,
    sourceId: string,
    snippet?: string
  ): Source => ({
    id: page ? `doc ${sourceName} p.${page}` : `doc ${sourceName}`,
    kind: "doc",
    label: page ? `${sourceName}, p. ${page}` : sourceName,
    href: `/knowledge#source-${sourceId}`,
    detail: snippet,
  }),
  plan: (): Source => ({
    id: "plan",
    kind: "plan",
    label: "Current plan",
    href: "/schedule",
  }),
  check: (orderNo: string, runId?: string): Source => ({
    id: `check ${orderNo}`,
    kind: "check",
    label: `Capacity check ${orderNo}`,
    href: runId ? `/schedule/check?run=${runId}` : "/schedule/check",
  }),
  query: (n: number, purpose: string, sql: string): Source => ({
    id: `query ${n}`,
    kind: "query",
    label: `Query ${n}`,
    detail: purpose,
    sql,
  }),
  fact: (label: string, description: string): Source => ({
    id: `fact ${label}`,
    kind: "fact",
    label,
    detail: description,
    href: `/knowledge/facts?f=${enc(label)}`,
  }),
  estimate: (n: number, description: string): Source => ({
    id: `estimate ${n}`,
    kind: "estimate",
    label: `Estimate ${n}`,
    detail: description,
    href: "/quotes",
  }),
  scenario: (n: number, description: string): Source => ({
    id: `scenario ${n}`,
    kind: "scenario",
    label: `Scenario ${n}`,
    detail: description,
    href: "/schedule",
  }),
};

/** Columns in ask.* views that name a record we can link to. */
const KEY_COLUMNS: Record<string, (value: string) => Source> = {
  order_no: cite.order,
  part_no: (v) => cite.part(v),
  quote_no: cite.quote,
  work_center: cite.machine,
  customer: cite.customer,
  material: cite.material,
  fact_no: (v) => cite.fact(v, "Fact"),
};

const MAX_ROW_SOURCES = 60;

/** Sources for the records a query returned, so answers can cite them. */
export const sourcesFromRows = (
  rows: readonly Record<string, unknown>[]
): Source[] => {
  const found = new Map<string, Source>();
  for (const row of rows) {
    if (typeof row.part_no === "string" && typeof row.seq === "number") {
      const routing = cite.routing(row.part_no, row.seq);
      found.set(routing.id, routing);
    }
    for (const [column, make] of Object.entries(KEY_COLUMNS)) {
      const value = row[column];
      if (typeof value === "string" && value && found.size < MAX_ROW_SOURCES) {
        const source = make(value);
        found.set(source.id, source);
      }
    }
  }
  return [...found.values()];
};

const BRACKETS = /[[\]]/g;

const normalize = (id: string) => id.replace(/\s+/g, " ").trim().toLowerCase();

export const CITATION = new RegExp(
  `\\[(${SOURCE_KINDS.join("|")})(?: ([^\\]\\n]{1,160}))?\\]`,
  "g"
);

/** Collect sources from tool outputs (anything with a `sources` array). */
export const collectSources = (
  outputs: readonly unknown[]
): Map<string, Source> => {
  const registry = new Map<string, Source>();
  for (const output of outputs) {
    const sources = (output as { sources?: unknown })?.sources;
    if (Array.isArray(sources)) {
      for (const source of sources as Source[]) {
        if (source && typeof source.id === "string") {
          registry.set(normalize(source.id), source);
        }
      }
    }
  }
  return registry;
};

export interface LinkedText {
  /** Sources cited, in order of first use (N in #cite-N indexes this). */
  cited: Source[];
  /** Markdown with each citation turned into a [label](#cite-N) link. */
  markdown: string;
  /** Citations no tool result backs up. */
  unverified: string[];
}

/** Turn [kind id] citations into links to their sources. */
export const linkCitations = (
  text: string,
  registry: ReadonlyMap<string, Source>
): LinkedText => {
  const cited: Source[] = [];
  const unverified: string[] = [];
  const markdown = text.replace(
    CITATION,
    (_match, kind: string, rest?: string) => {
      const id = rest ? `${kind} ${rest}` : kind;
      const source = registry.get(normalize(id));
      if (!source) {
        unverified.push(id);
        // Shown as plain text, flagged; escaped so markdown doesn't read a link.
        return `\\[${id} (unverified)\\]`;
      }
      let index = cited.indexOf(source);
      if (index < 0) {
        cited.push(source);
        index = cited.length - 1;
      }
      return `[${source.label.replace(BRACKETS, "")}](#cite-${index})`;
    }
  );
  return { markdown, cited, unverified };
};

const TWO_DIGITS = /\d{2,}/;
const TABLE_ROW = /^\s*\|/;
const HEADING = /^\s*#/;
// A line ending in a colon (bold or not) introduces what follows.
const INTRODUCES_LIST = /:\s*(\*\*|__)?\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
// Offers, questions and the agent's own assumptions aren't claims from data.
const NOT_A_CLAIM =
  /\?\s*$|^\W*(I can|I could|I'll|I will|I assumed|I'm assuming|Assuming|If you|If the customer|Want me|Do you want|Would you like|Let me know)\b/i;
// Record names aren't quantities: SO-5003, P-1001, HAAS-VF2, SS316, AL6061-T6.
// Record names (SO-5003, HAAS-VF2) and operation numbers ("op 10") aren't figures.
const IDENTIFIER =
  /\b(?:[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9-]*\d[A-Za-z0-9-]*|[A-Z]{2,}\d+[A-Za-z0-9]*|op(?:eration)?s? \d+(?:(?:,| and| or) \d+)*)\b/gi;

/**
 * Lines (sentences or bullets) that state a number but carry no citation.
 * Exempt: table rows and headings (the sentence introducing a table cites
 * it), lines that just introduce a list, and record names like SO-5003.
 * Used by the evals: a good answer returns none.
 */
export const uncitedNumbers = (text: string) => {
  const uncited: string[] = [];
  // A cited lead-in ("Machine load [plan]:") covers the list under it.
  let coveredIndent: number | null = null;
  for (const line of text.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const listItem = LIST_ITEM.test(line);
    if (
      coveredIndent !== null &&
      line.trim() &&
      !(listItem && indent >= coveredIndent) &&
      indent <= coveredIndent
    ) {
      coveredIndent = null;
    }
    const cited = line.replace(CITATION, "").length !== line.length;
    if (INTRODUCES_LIST.test(line)) {
      if (cited && coveredIndent === null) {
        coveredIndent = indent;
      }
      continue;
    }
    if (
      coveredIndent !== null ||
      cited ||
      TABLE_ROW.test(line) ||
      HEADING.test(line) ||
      NOT_A_CLAIM.test(line.trim())
    ) {
      continue;
    }
    if (TWO_DIGITS.test(line.replace(IDENTIFIER, ""))) {
      uncited.push(line);
    }
  }
  return uncited;
};
