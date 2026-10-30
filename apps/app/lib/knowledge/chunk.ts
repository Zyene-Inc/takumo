// Splits document text into overlapping chunks for search. Pure, so tested.

export interface PageText {
  /** 1-based page number, or null when the format has no pages (Word, text). */
  page: number | null;
  text: string;
}

export interface Chunk {
  content: string;
  /** The nearest heading above the chunk, for context in search results. */
  heading: string | null;
  page: number | null;
}

/** About 250 words per chunk, with some overlap so sentences aren't cut off. */
export const CHUNK_CHARS = 1400;
export const OVERLAP_CHARS = 200;

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

/** Cut a long paragraph at sentence ends, falling back to a hard cut. */
const splitLong = (paragraph: string): string[] => {
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

export const chunkPages = (pages: PageText[]): Chunk[] => {
  const chunks: Chunk[] = [];
  let heading: string | null = null;

  for (const { page, text } of pages) {
    const paragraphs = text
      .replaceAll("\r\n", "\n")
      .split(BLANK_LINES)
      .map((p) => p.replace(SPACES, " ").trim())
      .filter(Boolean)
      .flatMap(splitLong);

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
        // Carry the end of the previous chunk over for context.
        const tail = current.slice(-OVERLAP_CHARS);
        const sentence = tail.indexOf(". ");
        current = sentence >= 0 ? tail.slice(sentence + 2) : "";
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
