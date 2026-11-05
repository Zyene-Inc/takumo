// @vitest-environment node
// Documents by email (F6.2-R1): the docs-…@ address is recognised, which
// attachments are read, and the reply says what each became.
import { describe, expect, test } from "vitest";
import { docsReply, pickDocuments } from "../lib/inbound/docs-email";
import { INBOUND_KINDS, parseAddress } from "../lib/inbound/verify";

const file = (name: string, size = 50_000) => ({
  name,
  bytes: new Uint8Array(size),
});

describe("docs address", () => {
  test("is one of the shop's addresses", () => {
    expect(INBOUND_KINDS).toContain("docs");
    expect(
      parseAddress("docs-abcd1234ef@in.takumo.ai", "in.takumo.ai")
    ).toEqual({ kind: "docs", token: "abcd1234ef" });
    expect(
      parseAddress("docs-abcd1234ef@other.example", "in.takumo.ai")
    ).toBeNull();
  });
});

describe("pickDocuments", () => {
  test("reads documents, skips signature images, says what's left out", () => {
    const { read, left } = pickDocuments([
      file("Setup sheet P-1001.pdf"),
      file("logo.png", 3000),
      file("traveler photo.jpg"),
      file("drawing.step"),
      file("huge.pdf", 21 * 1024 * 1024),
    ]);
    expect(read.map((r) => r.name)).toEqual([
      "Setup sheet P-1001.pdf",
      "traveler photo.jpg",
    ]);
    expect(left).toEqual([
      expect.stringContaining("drawing.step: Takumo reads"),
      "huge.pdf: larger than 20 MB",
    ]);
  });

  test("at most 10 per email", () => {
    const { read, left } = pickDocuments(
      Array.from({ length: 12 }, (_, i) => file(`doc${i}.pdf`))
    );
    expect(read).toHaveLength(10);
    expect(left).toHaveLength(2);
  });
});

describe("docsReply", () => {
  const urls = {
    knowledgeUrl: "https://app.example.com/knowledge",
    factsUrl: "https://app.example.com/knowledge/facts",
  };

  test("lists linked records and proposed facts per document", () => {
    const text = docsReply({
      ...urls,
      left: [],
      outcomes: [
        {
          ok: true,
          name: "Setup sheet P-1001",
          facts: ["F-4", "F-5"],
          linked: 2,
          passages: 3,
          steps: [
            "Reading Setup sheet P-1001.pdf",
            "Identified a setup sheet: P-1001 op 20",
            "Linked to your records: P-1001 rev A, HAAS VF-2",
          ],
        },
        { ok: false, name: "scan.pdf", error: "no text found in it." },
      ],
    });
    expect(text).toContain("Takumo read 1 of 2 documents.");
    expect(text).toContain("Linked to your records: P-1001 rev A, HAAS VF-2");
    expect(text).toContain("Identified a setup sheet");
    expect(text).not.toContain("Reading Setup sheet");
    expect(text).toContain("2 facts proposed for review: F-4, F-5");
    expect(text).toContain("Couldn't read it: no text found in it.");
    expect(text).toContain(urls.factsUrl);
  });

  test("no documents: asks for one; no facts: no facts link", () => {
    expect(docsReply({ ...urls, left: [], outcomes: [] })).toContain(
      "didn't find a document"
    );
    const none = docsReply({
      ...urls,
      left: ["a.step: Takumo reads .pdf"],
      outcomes: [
        { ok: true, name: "SOP", facts: [], linked: 0, passages: 1, steps: [] },
      ],
    });
    expect(none).toContain(
      "Takumo read 1 document. It's on the Knowledge page"
    );
    expect(none).toContain("Not linked to any part");
    expect(none).toContain("Left out:");
    expect(none).not.toContain(urls.factsUrl);
  });
});
