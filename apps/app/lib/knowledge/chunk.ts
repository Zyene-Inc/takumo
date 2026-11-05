// Splits document text into overlapping chunks for search. Pure, so tested.

export interface PageText {
  /** 1-based page number, or null when the format has no pages (Word, text). */
  page: number | null;
  text: string;
}

interface Chunk {
  content: string;
  /** The nearest heading above the chunk, for context in search results. */
  heading: string | null;
  page: number | null;
}

/** About 250 words per chunk, with some overlap so sentences aren't cut off. */
export const CHUNK_CHARS = 1400;
const OVERLAP_CHARS = 200;

const MARKDOWN_HEADING = /^#{1,6}\s+(.+)$/;
const SHOUTED_HEADING = /^[A-Z0-9][A-Z0-9 &/,.:()-]{3,60}$/;
const BLANK_LINES = /\n\s*\n/;
const SPACES = /[ \t]+/g;
const SENTENCE_END = /[.!?]\s/g;
const HAS_LETTER = /[A-Z]/;
const NOT_WORD = /[^\p{L}\p{N}-]+/u;
const EDGE_HYPHENS = /^-+|-+$/g;

const headingOf = (paragraph: string) => {
  const line = paragraph.trim();
  if (line.includes("\n")) {
    return null;
  }
  const markdown = line.match(MARKDOWN_HEADING);
  if (markdown) {
    return markdown[1].trim();
  }
  return SHOUTED_HEADING.test(line) && HAS_LETTER.test(line) ? line : null;
};

/** Tables may run longer than prose before they're split, to stay whole. */
export const TABLE_CHARS = 2400;
const HTML_TABLE = /<table[\s\S]*?<\/table>/gi;
const HTML_ROW = /<tr[\s\S]*?<\/tr>/gi;
const HTML_CELL = /<t([hd])[^>]*>([\s\S]*?)<\/t[hd]>/gi;
const TAGS = /<[^>]+>/g;
const PIPE = /\|/g;
const WHITESPACE = /\s+/g;
const SEPARATOR_ROW = /^\|(\s*:?-{3,}:?\s*\|)+$/;

/**
 * HTML tables (how scans are read) as Markdown pipe tables: one row per line,
 * so a passage, a search snippet or a fact's evidence reads like the sheet
 * ("| 20 | HAAS VF-2 | 45 |") instead of markup. Pure, so tested.
 */
export const htmlTablesToMarkdown = (text: string) =>
  text.replace(HTML_TABLE, (table) => {
    const rows = (table.match(HTML_ROW) ?? []).map((row) =>
      [...row.matchAll(HTML_CELL)].map((cell) =>
        cell[2]
          .replace(TAGS, " ")
          .replace(PIPE, "/")
          .replace(WHITESPACE, " ")
          .trim()
      )
    );
    const width = Math.max(0, ...rows.map((r) => r.length));
    if (width === 0) {
      return table.replace(TAGS, " ");
    }
    const line = (cells: string[]) =>
      `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
    const [header, ...body] = rows;
    return [
      line(header),
      line(Array.from({ length: width }, () => "---")),
      ...body.map(line),
    ].join("\n");
  });

/**
 * A long pipe table split between rows, never inside one; every piece repeats
 * the header so it still makes sense on its own.
 */
const splitTable = (table: string): string[] => {
  if (table.length <= TABLE_CHARS) {
    return [table];
  }
  const lines = table.split("\n");
  const headed =
    lines.length > 2 && SEPARATOR_ROW.test(lines[1].replace(WHITESPACE, ""));
  const header = headed ? lines.slice(0, 2) : [];
  const body = headed ? lines.slice(2) : lines;
  const pieces: string[] = [];
  let current: string[] = [];
  const size = (rows: string[]) =>
    [...header, ...rows].reduce((n, row) => n + row.length + 1, 0);
  for (const row of body) {
    if (current.length && size([...current, row]) > TABLE_CHARS) {
      pieces.push([...header, ...current].join("\n"));
      current = [];
    }
    current.push(row);
  }
  if (current.length) {
    pieces.push([...header, ...current].join("\n"));
  }
  return pieces;
};

const isTable = (paragraph: string) => paragraph.startsWith("|");

/** Cut a long paragraph at sentence ends, falling back to a hard cut. */
const splitLong = (paragraph: string): string[] => {
  if (isTable(paragraph)) {
    return splitTable(paragraph);
  }
  if (paragraph.length <= CHUNK_CHARS) {
    return [paragraph];
  }
  const parts: string[] = [];
  let rest = paragraph;
  while (rest.length > CHUNK_CHARS) {
    const window = rest.slice(0, CHUNK_CHARS);
    let cut = -1;
    for (const match of window.matchAll(SENTENCE_END)) {
      cut = (match.index ?? 0) + 1;
    }
    if (cut < CHUNK_CHARS / 2) {
      cut = CHUNK_CHARS;
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    parts.push(rest);
  }
  return parts;
};

/** A page's paragraphs, each short enough for a chunk (tables kept whole). */
const paragraphsOf = (text: string) =>
  text
    .replaceAll("\r\n", "\n")
    .replace(HTML_TABLE, (t) => `\n\n${htmlTablesToMarkdown(t)}\n\n`)
    .split(BLANK_LINES)
    // Tables keep their line breaks (one row per line); prose is one line.
    .map((p) => (isTable(p.trim()) ? p.trim() : p.replace(SPACES, " ").trim()))
    .filter(Boolean)
    .flatMap(splitLong);

/**
 * The end of a chunk, carried into the next for context: from a sentence
 * start, and never half a table, which would read as broken markup.
 */
const carryOver = (chunk: string) => {
  if (isTable(chunk.slice(chunk.lastIndexOf("\n\n") + 2))) {
    return "";
  }
  const tail = chunk.slice(-OVERLAP_CHARS);
  const sentence = tail.indexOf(". ");
  return sentence >= 0 ? tail.slice(sentence + 2) : "";
};

export const chunkPages = (pages: PageText[]): Chunk[] => {
  const chunks: Chunk[] = [];
  let heading: string | null = null;

  for (const { page, text } of pages) {
    const paragraphs = paragraphsOf(text);

    let current = "";
    let currentHeading = heading;
    const flush = () => {
      if (current.trim()) {
        chunks.push({ content: current.trim(), heading: currentHeading, page });
      }
    };

    for (const paragraph of paragraphs) {
      const found = headingOf(paragraph);
      if (found) {
        heading = found;
      }
      if (current && current.length + paragraph.length + 2 > CHUNK_CHARS) {
        flush();
        current = carryOver(current);
        currentHeading = heading;
      }
      if (!current) {
        currentHeading = heading;
      }
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    flush();
  }
  return chunks;
};

/** Words for an OR keyword query; Postgres stems and ranks them. */
export const searchTerms = (query: string) =>
  [
    ...new Set(
      query
        .toLowerCase()
        .split(NOT_WORD)
        .map((w) => w.replace(EDGE_HYPHENS, ""))
        .filter((w) => w.length > 1)
    ),
  ].slice(0, 24);

const MARKDOWN_MARKS = /(^|\s)#{1,6}\s+|[*_`>]+/g;

/** A short plain-text preview of a document's opening. */
export const plainSummary = (content: string, length = 280) => {
  const text = content
    .replace(MARKDOWN_MARKS, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

/** Search snippets: plain text, matches wrapped in « » (see ts_headline). */
export const cleanSnippet = (snippet: string) =>
  snippet.replace(MARKDOWN_MARKS, "$1").replace(/\s+/g, " ").trim();

const HIGHLIGHT = /«([^»]*)»/g;

/** Split a snippet into plain and highlighted runs, for rendering. */
export const snippetRuns = (snippet: string) => {
  const runs: { match: boolean; start: number; text: string }[] = [];
  let last = 0;
  for (const m of snippet.matchAll(HIGHLIGHT)) {
    if ((m.index ?? 0) > last) {
      runs.push({
        text: snippet.slice(last, m.index),
        match: false,
        start: last,
      });
    }
    runs.push({ text: m[1], match: true, start: m.index ?? 0 });
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < snippet.length) {
    runs.push({ text: snippet.slice(last), match: false, start: last });
  }
  return runs;
};
