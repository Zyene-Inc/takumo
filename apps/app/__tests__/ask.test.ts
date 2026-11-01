import { readFileSync } from "node:fs";
import path from "node:path";
import { checkSql, QueryError } from "@repo/database/sql-guard";
import { describe, expect, test } from "vitest";
import { hintedMode, splitAnswer } from "../lib/agent/answer";
import {
  cite,
  collectSources,
  linkCitations,
  sourcesFromRows,
  uncitedNumbers,
} from "../lib/agent/citations";
import { buildStarters, STARTER_TOPICS } from "../lib/agent/starters";
import {
  CHUNK_CHARS,
  chunkPages,
  cleanSnippet,
  plainSummary,
  searchTerms,
  snippetRuns,
} from "../lib/knowledge/chunk";
import { extractPages } from "../lib/knowledge/extract";

describe("SQL guard", () => {
  test("allows one SELECT or WITH, with comments and a trailing semicolon", () => {
    expect(checkSql("select * from orders;")).toBe("select * from orders");
    expect(checkSql("-- late\nWITH x AS (select 1) select * from x")).toContain(
      "WITH x"
    );
    expect(checkSql("/* hi */ select 'delete me' as note")).toBe(
      "select 'delete me' as note"
    );
  });

  test.each([
    ["", "empty"],
    ["delete from orders", "SELECT"],
    ["select 1; select 2", "one SELECT"],
    ["select pg_sleep(10)", "pg_sleep"],
    ["select set_config('takumo.org_id', 'x', true)", "set_config"],
    ["with d as (delete from orders returning *) select * from d", "delete"],
    ["select * from orders for update", "update"],
  ])("rejects %j", (sql, message) => {
    expect(() => checkSql(sql)).toThrow(QueryError);
    expect(() => checkSql(sql)).toThrow(new RegExp(message, "i"));
  });

  test("keywords inside column names are fine", () => {
    expect(() =>
      checkSql("select actual_cost, created_on, updated from quotes")
    ).not.toThrow();
  });
});

describe("citations", () => {
  const registry = collectSources([
    {
      sources: [
        cite.order("SO-5001"),
        cite.query(1, "Late orders", "select 1"),
      ],
    },
    { sources: [cite.doc("Setup notes", 2, "src1", "Use soft jaws")] },
    { rows: [] }, // tools without sources are ignored
  ]);

  test("turns known citations into numbered links, in order of first use", () => {
    const { markdown, cited, unverified } = linkCitations(
      "SO-5001 is late [order SO-5001] by 3 days [query 1]. See [doc Setup notes p.2] and again [order SO-5001].",
      registry
    );
    expect(cited.map((s) => s.id)).toEqual([
      "order SO-5001",
      "query 1",
      "doc Setup notes p.2",
    ]);
    expect(markdown).toContain("[SO-5001](#cite-0)");
    expect(markdown).toContain("[Query 1](#cite-1)");
    expect(markdown).toContain("[Setup notes, p. 2](#cite-2)");
    expect(markdown.match(/#cite-0/g)).toHaveLength(2);
    expect(unverified).toEqual([]);
  });

  test("matching ignores case and spacing", () => {
    expect(linkCitations("[order  so-5001]", registry).cited).toHaveLength(1);
  });

  test("flags citations no tool returned", () => {
    const { markdown, unverified } = linkCitations(
      "Due soon [order SO-9999].",
      registry
    );
    expect(unverified).toEqual(["order SO-9999"]);
    expect(markdown).toContain("order SO-9999 (unverified)");
    expect(markdown).not.toContain("#cite");
  });

  test("query rows become citable records", () => {
    const sources = sourcesFromRows([
      { order_no: "SO-1", customer: "Acme", qty: 5 },
      { order_no: "SO-2", customer: "Acme", work_center: "HAAS-VF2" },
    ]);
    expect(sources.map((s) => s.id).sort()).toEqual([
      "customer Acme",
      "machine HAAS-VF2",
      "order SO-1",
      "order SO-2",
    ]);
    expect(sources.find((s) => s.kind === "order")?.href).toBe(
      "/shop/orders?q=SO-1"
    );
    expect(
      sourcesFromRows([
        { part_no: "P-2001", seq: 10, work_center: "OKUMA" },
      ]).map((s) => s.id)
    ).toContain("routing P-2001 op 10");
  });

  test("finds lines with numbers but no citation; tables and headings are exempt", () => {
    const answer = [
      "We have 12 late orders [query 1].",
      "- Revenue was $45,000 this month.",
      "| SO-5001 | 200 |",
      "## Top 10",
      "Load over the next 14 days:",
      "I can also check whether SO-5003 on OKUMA-LB3000 (SS316) is at risk.",
      "Nothing else to add.",
      "The other machines are lighter [plan]:",
      "  - AMADA-HG1303: 49%",
      "  - HAAS-VF4: 41%",
      "The setup notes add [doc Setup notes p.1]:",
      "- Warm up for 15 minutes.",
      "",
      "- Steady rest over 200 mm.",
      "I can also show the next 7 and 14 days.",
      "Do you want the 200-piece split?",
      "**Options (neither gets all 400 out by Nov 6):**",
      "Op 10 on the OKUMA has no backup machine, so it takes most of the time.",
      "Ops 10 and 20 run on different machines.",
      "- Split into two runs of 200 [check NEW-1].",
      "Overall 12 orders.",
    ].join("\n");
    expect(uncitedNumbers(answer)).toEqual([
      "- Revenue was $45,000 this month.",
      "Overall 12 orders.",
    ]);
  });
});

describe("document chunking", () => {
  test("keeps pages and the nearest heading", () => {
    const chunks = chunkPages([
      { page: 1, text: "# Setup notes\n\nHAAS-VF2 uses soft jaws for P-1001." },
      { page: 2, text: "DEBURRING\n\nBreak all edges 0.2 mm." },
    ]);
    expect(chunks).toEqual([
      {
        page: 1,
        heading: "Setup notes",
        content: "# Setup notes\n\nHAAS-VF2 uses soft jaws for P-1001.",
      },
      {
        page: 2,
        heading: "DEBURRING",
        content: "DEBURRING\n\nBreak all edges 0.2 mm.",
      },
    ]);
  });

  test("splits long text into overlapping chunks under the size limit", () => {
    const sentence =
      "The spindle warms up for ten minutes before the first part. ";
    const text = Array.from(
      { length: 12 },
      (_, i) => `${sentence.repeat(8)}Paragraph ${i}.`
    ).join("\n\n");
    const chunks = chunkPages([{ page: null, text }]);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(CHUNK_CHARS + 300);
    }
    // Every paragraph made it into some chunk.
    for (let i = 0; i < 12; i += 1) {
      expect(chunks.some((c) => c.content.includes(`Paragraph ${i}.`))).toBe(
        true
      );
    }
  });

  test("an empty document has no chunks", () => {
    expect(chunkPages([{ page: 1, text: "  \n\n " }])).toEqual([]);
  });

  test("search terms keep part numbers and drop noise", () => {
    expect(searchTerms("How do we deburr P-2001? (soft jaws)")).toEqual([
      "how",
      "do",
      "we",
      "deburr",
      "p-2001",
      "soft",
      "jaws",
    ]);
  });
});

const READS = /reads/;

describe("document text extraction", () => {
  const fixture = (name: string) =>
    new Uint8Array(
      readFileSync(path.join(import.meta.dirname, "fixtures", name))
    );

  test("reads PDF pages", async () => {
    const pages = await extractPages("sample.pdf", fixture("sample.pdf"));
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(1);
    expect(pages[0].text).toContain("Break all edges 0.2 to 0.4 mm on P-3001");
  });

  test("reads Word documents", async () => {
    const pages = await extractPages("sample.docx", fixture("sample.docx"));
    expect(pages[0].page).toBeNull();
    expect(pages[0].text).toContain("Deburr standard");
  });

  test("refuses other files", async () => {
    await expect(
      extractPages("photo.png", new Uint8Array([1]))
    ).rejects.toThrow(READS);
  });

  test("snippets are plain text with highlighted runs", () => {
    const snippet = cleanSnippet("## OKUMA\n**P-2001**: run «coolant» at «8%»");
    expect(snippet).toBe("OKUMA P-2001: run «coolant» at «8%»");
    expect(snippetRuns(snippet)).toEqual([
      { text: "OKUMA P-2001: run ", match: false, start: 0 },
      { text: "coolant", match: true, start: 18 },
      { text: " at ", match: false, start: 27 },
      { text: "8%", match: true, start: 31 },
    ]);
  });

  test("summaries drop Markdown symbols", () => {
    expect(plainSummary("# Setup notes\n\n## HAAS-VF2\n**Soft** jaws")).toBe(
      "Setup notes HAAS-VF2 Soft jaws"
    );
  });
});

describe("answer blocks", () => {
  test("follow-ups and options come out of the text", () => {
    const answer = splitAnswer(
      "SO-5003 is late [order SO-5003].\n\n<follow-ups>\n- Which jobs hold up SO-5003?\n- Can we pull it in with overtime?\n</follow-ups>"
    );
    expect(answer.body).toBe("SO-5003 is late [order SO-5003].");
    expect(answer.followUps).toEqual([
      "Which jobs hold up SO-5003?",
      "Can we pull it in with overtime?",
    ]);
    expect(answer.options).toEqual([]);

    const question = splitAnswer(
      "Which rev?\n<options>\n- P-1001 rev A\n* P-1001 rev B\n</options>"
    );
    expect(question.body).toBe("Which rev?");
    expect(question.options).toEqual(["P-1001 rev A", "P-1001 rev B"]);
  });

  test("a block still streaming in is hidden, not shown as text", () => {
    expect(splitAnswer("Done [plan].\n<follow-ups>\n- Which ma").body).toBe(
      "Done [plan]."
    );
    expect(splitAnswer("Done [plan].\n<follo").body).toBe("Done [plan].");
    expect(splitAnswer("Done [plan].\n<").body).toBe("Done [plan].");
  });

  test("buttons are short and few", () => {
    const many = splitAnswer(
      `<follow-ups>\n${["a", "b", "c", "d", "e"].map((q) => `- ${q}`).join("\n")}\n- ${"x".repeat(200)}\n</follow-ups>`
    );
    expect(many.followUps).toEqual(["a", "b", "c", "d"]);
  });

  test("text without blocks is unchanged", () => {
    expect(splitAnswer("Plain answer with a < sign: 3 < 5.").body).toBe(
      "Plain answer with a < sign: 3 < 5."
    );
  });
});

describe("answer mode", () => {
  test("planning, pricing and what-ifs skip the router and go thorough", () => {
    for (const q of [
      "Can we take 150 × P-1001 by next Friday?",
      "What should we quote for 500 of P-2001?",
      "What if HAAS-VF2 goes down for a week?",
      "Which machine is the bottleneck?",
    ]) {
      expect(hintedMode(q)).toBe("thorough");
    }
  });

  test("look-ups are left to the router", () => {
    for (const q of [
      "Show me SO-5003",
      "Which orders are late?",
      "List our customers",
    ]) {
      expect(hintedMode(q)).toBeNull();
    }
  });
});

describe("start screen examples", () => {
  const rows = {
    today: "2026-11-01",
    parts: ["P-1001", "P-2001"],
    orders: [
      { orderNo: "SO-5003", partNo: "P-3001", qty: 120 },
      { orderNo: "SO-5001", partNo: "P-1001", qty: 40 },
    ],
    machines: ["HAAS-VF2", "OKUMA-LB3000"],
    customers: ["Bluefin Marine"],
    quotes: ["Q-9008"],
    documents: ["Setup notes"],
  };

  test("examples name the shop's own records", () => {
    const s = buildStarters(rows);
    expect(s.capacity[0]).toBe("Can we take another 120 × P-3001 by Nov 22?");
    expect(s.capacity).toContain("Can we pull SO-5003 in by a week?");
    expect(s.quotes[0]).toBe("What should we quote for 250 × P-1001?");
    expect(s.schedule).toContain("When will SO-5003 finish?");
    expect(s.machines[0]).toBe(
      "How loaded is HAAS-VF2 over the next two weeks?"
    );
    expect(s.setup).toContain('What does "Setup notes" say?');
    expect(
      buildStarters({ ...rows, documents: ["02_20251204 - scan"] }).setup.join()
    ).not.toContain("02_");
  });

  test("a new shop with no data still gets four questions per topic", () => {
    const s = buildStarters({
      today: "2026-11-01",
      parts: [],
      orders: [],
      machines: [],
      customers: [],
      quotes: [],
      documents: [],
    });
    for (const t of STARTER_TOPICS) {
      expect(s[t]).toHaveLength(4);
      expect(s[t].join(" ")).not.toMatch(/undefined|null/);
    }
  });
});
