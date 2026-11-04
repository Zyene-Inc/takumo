import { zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  duplicateKey,
  expandPackage,
  kindOf,
  looksLikeDrawing,
  MAX_FILE_BYTES,
  MAX_RFQ_FILES_BYTES,
  MAX_ZIP_ENTRIES,
  requestText,
  senderAddress,
  sha256Of,
  subjectKey,
  unpackZip,
  withinLimits,
} from "../lib/quotes/attachments";
import { channelOf, looksLikeForm } from "../lib/quotes/channel";
import {
  readCall,
  readPasted,
  readRfqFile,
  readRfqUpload,
} from "../lib/quotes/read";

const FIRST_200 = /first 200 files/;
const BIG_BIN = /big\.bin/;
const NOT_A_ZIP = /not a zip/;
const SETUP_EXE = /setup\.exe/;

const bytes = (text: string) => new TextEncoder().encode(text);
const blob = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

const TITLE_BLOCK = [
  "UNLESS OTHERWISE SPECIFIED DIMENSIONS ARE IN INCHES",
  "TOLERANCES: .XX ±.01 .XXX ±.005",
  "THIRD ANGLE PROJECTION   SCALE 2:1   SHEET 1 OF 2",
  "DWG NO 10442   REV C",
];

describe("what kind of file came with an RFQ", () => {
  test("3D models, images and documents by extension", () => {
    expect(kindOf("bracket.STEP")).toBe("model");
    expect(kindOf("housing.x_t")).toBe("model");
    expect(kindOf("photo.jpg")).toBe("image");
    expect(kindOf("P-1001 dwg.png")).toBe("drawing");
    expect(kindOf("terms.docx")).toBe("document");
    // CAD the drawing reader can't read: kept, and a PDF is asked for.
    expect(kindOf("print.dxf")).toBe("model");
    expect(kindOf("print.dwg")).toBe("model");
    expect(kindOf("archive.7z")).toBe("other");
  });

  test("a PDF is a drawing when its text reads like a title block", () => {
    expect(looksLikeDrawing(TITLE_BLOCK)).toBe(true);
    expect(kindOf("10442.pdf", TITLE_BLOCK)).toBe("drawing");
    expect(
      kindOf("rfq.pdf", ["Please quote the attached parts. Thank you."])
    ).toBe("document");
  });

  test("a scanned PDF is a drawing only when its name says so", () => {
    expect(kindOf("P-1001 drawing.pdf", ["", " "])).toBe("drawing");
    expect(kindOf("scan0001.pdf", ["", " "])).toBe("document");
  });
});

describe("zipped RFQ packages", () => {
  test("unpacks files, drops folders and Mac junk", () => {
    const zip = zipSync({
      "pkg/rfq.txt": bytes("Quote 10 pcs of P-1"),
      "pkg/P-1.step": blob(100),
      "__MACOSX/pkg/._P-1.step": blob(10),
      "pkg/.DS_Store": blob(10),
    });
    const { files, skipped } = unpackZip("pkg.zip", zip);
    expect(files.map((f) => f.name).sort()).toEqual(["P-1.step", "rfq.txt"]);
    expect(skipped).toEqual([]);
  });

  test("stops at the entry limit", () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_ZIP_ENTRIES + 5; i += 1) {
      many[`f${i}.txt`] = bytes(`file ${i}`);
    }
    const { files, skipped } = unpackZip("many.zip", zipSync(many));
    expect(files).toHaveLength(MAX_ZIP_ENTRIES);
    expect(skipped.join(" ")).toMatch(FIRST_200);
  });

  test("leaves out a file that's too large once unpacked", () => {
    // Compresses to almost nothing: a small zip that unpacks huge.
    const bomb = zipSync({ "big.bin": new Uint8Array(MAX_FILE_BYTES + 1) });
    expect(bomb.length).toBeLessThan(100_000);
    const { files, skipped } = unpackZip("bomb.zip", bomb);
    expect(files).toEqual([]);
    expect(skipped.join(" ")).toMatch(BIG_BIN);
  });

  test("a broken zip is noted, not thrown", () => {
    expect(unpackZip("bad.zip", bytes("not a zip")).skipped[0]).toMatch(
      NOT_A_ZIP
    );
  });

  test("expanding a package drops empty files and signature logos", () => {
    const zip = zipSync({ "a.pdf": blob(50) });
    const { files } = expandPackage([
      { name: "pkg.zip", bytes: zip },
      { name: "image001.png", bytes: blob(2000) },
      { name: "empty.txt", bytes: new Uint8Array(0) },
      { name: "drawing.png", bytes: blob(40_000) },
    ]);
    expect(files.map((f) => f.name)).toEqual(["a.pdf", "drawing.png"]);
  });
});

describe("size limits", () => {
  const file = (name: string, n: number, fill = 1) => {
    const data = blob(n, fill);
    return { name, bytes: data, sha256: sha256Of(data) };
  };

  test("each file up to 20 MB, all together up to 50 MB, each file once", () => {
    const { kept, skipped } = withinLimits([
      file("a.pdf", MAX_FILE_BYTES + 1, 1),
      file("b.pdf", 18 * 1024 * 1024, 2),
      file("b copy.pdf", 18 * 1024 * 1024, 2),
      file("c.pdf", 18 * 1024 * 1024, 3),
      file("d.pdf", 18 * 1024 * 1024, 4),
    ]);
    expect(kept.map((f) => f.name)).toEqual(["b.pdf", "c.pdf"]);
    expect(kept.reduce((s, f) => s + f.bytes.length, 0)).toBeLessThanOrEqual(
      MAX_RFQ_FILES_BYTES
    );
    expect(skipped).toEqual([
      "a.pdf: over 20 MB",
      "d.pdf: the RFQ's files are over 50 MB together",
    ]);
  });
});

describe("the same RFQ twice", () => {
  test("same sender, whatever the display name or case, and same files", () => {
    expect(senderAddress("Jo Buyer <Jo@Acme.COM>")).toBe("jo@acme.com");
    expect(senderAddress("not an address")).toBeNull();
    expect(duplicateKey("Jo <jo@acme.com>", ["b", "a", "a"])).toBe(
      duplicateKey("JO@ACME.COM", ["a", "b"])
    );
  });

  test("different sender or files, or no files, never match", () => {
    expect(duplicateKey("jo@acme.com", ["a"])).not.toBe(
      duplicateKey("al@acme.com", ["a"])
    );
    expect(duplicateKey("jo@acme.com", ["a"])).not.toBe(
      duplicateKey("jo@acme.com", ["a", "b"])
    );
    expect(duplicateKey("jo@acme.com", [])).toBeNull();
  });
});

describe("the same text-only RFQ twice", () => {
  const RFQ = `Hi,

Please quote the following:
Part number: BRK-2201 Rev C, aluminium 6061-T6 bracket, anodize clear
Quantities: 50, 100, 250
Need by: Dec 15 2026

Thanks,
Jane Buyer`;
  const original = requestText("RFQ: BRK-2201 bracket", RFQ);

  test("sent again, with other line breaks and spacing: the same", () => {
    expect(original).not.toBeNull();
    const rewrapped = RFQ.replace(/\n/g, "\r\n").replace(/: /g, ":   ");
    expect(requestText("RFQ: BRK-2201 bracket", rewrapped)).toBe(original);
  });

  test("forwarded from Gmail with a note: the forwarded message only", () => {
    const gmail = `Can we quote this one by Friday?

---------- Forwarded message ---------
From: Jane Buyer <buyer@acme-aero.com>
Date: Tue, Nov 3, 2026 at 9:12 AM
Subject: RFQ: BRK-2201 bracket
To: <sales@myshop.com>

${RFQ}`;
    expect(requestText("Fwd: RFQ: BRK-2201 bracket", gmail)).toBe(original);
  });

  test("two people forwarding it, from Outlook and Apple Mail, match", () => {
    const outlook = `FYI, see below.

________________________________
From: Jane Buyer <buyer@acme-aero.com>
Sent: Tuesday, November 3, 2026 9:12 AM
To: Sales <sales@myshop.com>
Subject: RFQ: BRK-2201 bracket

${RFQ}`;
    const apple = `Begin forwarded message:

From: Jane Buyer <buyer@acme-aero.com>
Subject: RFQ: BRK-2201 bracket
Date: November 3, 2026 at 9:12:00 AM CST
To: sales@myshop.com

${RFQ}`;
    expect(requestText("FW: RFQ: BRK-2201 bracket", outlook)).toBe(original);
    expect(requestText("Fwd: RFQ: BRK-2201 bracket", apple)).toBe(original);
  });

  test("a reply quoting an old RFQ is a new request", () => {
    // Outlook's reply looks like its forward; only "FW:" makes it one.
    const reply = `Please also quote 500 pcs.

________________________________
From: Jane Buyer <buyer@acme-aero.com>
Sent: Tuesday, November 3, 2026 9:12 AM
To: Sales <sales@myshop.com>
Subject: RFQ: BRK-2201 bracket

${RFQ}`;
    expect(requestText("RE: RFQ: BRK-2201 bracket", reply)).not.toBe(original);
  });

  test("a different quantity is a different request", () => {
    const changed = RFQ.replace("50, 100, 250", "50, 100, 500");
    expect(requestText("RFQ: BRK-2201 bracket", changed)).not.toBe(original);
  });

  test("short generic text is never matched", () => {
    expect(requestText("Quote", "Please quote, thanks. Jane")).toBeNull();
  });

  test("the subject must match too, ignoring Fwd: and RE:", () => {
    expect(subjectKey("Fwd: FW: RFQ: BRK-2201 bracket")).toBe(
      subjectKey("RFQ: BRK-2201 bracket")
    );
    expect(subjectKey("RE: Fwd: rfq - brk-2201 BRACKET")).toBe(
      subjectKey("RFQ: BRK-2201 bracket")
    );
    // One template, the part only in the subject: two different RFQs.
    expect(subjectKey("RFQ: BRK-2201")).not.toBe(subjectKey("RFQ: BRK-2202"));
  });
});

describe("which channel an RFQ came through", () => {
  const email = (sender: string, subject = "RFQ", body = "Please quote") =>
    channelOf({ sender, subject, body });

  test("portal notifications by sender domain", () => {
    expect(email("Ariba <ordersender-prod@ansmtp.ariba.com>")).toBe("portal");
    expect(email("no-reply@paperlessparts.com")).toBe("portal");
    expect(email("rfq@supplierportal.bigcorp.com")).toBe("portal");
    expect(email("events@acme.coupahost.com")).toBe("portal");
  });

  test("website forms by sender, subject or a form-like body", () => {
    expect(email("WordPress <wordpress@myshop.com>")).toBe("form");
    expect(email("notifications@jotform.com")).toBe("form");
    expect(
      email("info@myshop.com", "New form submission: Request a quote")
    ).toBe("form");
    const body =
      "Name: Jo Buyer\nEmail: jo@acme.com\nPhone: 555-0100\nCompany: Acme\nMessage: Need 50 brackets in 6061";
    expect(looksLikeForm(body)).toBe(true);
    expect(email("info@myshop.com", "Website", body)).toBe("form");
  });

  test("a buyer's own email stays email", () => {
    expect(email("Jo Buyer <jo@acme.com>")).toBe("email");
    expect(
      looksLikeForm("Hi,\nPlease quote 50 pcs.\nThanks, Jo\nPhone: 555-0100")
    ).toBe(false);
  });

  test("pasted text: email, form or paste; calls are phone", () => {
    expect(readPasted("From: jo@acme.com\nSubject: RFQ\n\nQuote").source).toBe(
      "email"
    );
    expect(
      readPasted("Name: Jo\nEmail: jo@acme.com\nCompany: Acme\nMessage: 50 pcs")
        .source
    ).toBe("form");
    expect(readPasted("Quote 10 pcs of P-1").source).toBe("paste");
    expect(readCall("  Jo from Acme called, 50 pcs of P-1  ")).toMatchObject({
      source: "phone",
      body: "Jo from Acme called, 50 pcs of P-1",
      files: [],
    });
  });
});

describe("files kept from an email and from an upload", () => {
  const eml = [
    "From: Jo Buyer <jo@acme.com>",
    "Subject: RFQ brackets",
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain",
    "",
    "Please quote 50 pcs of P-1001 rev B.",
    "--B",
    'Content-Type: application/octet-stream; name="P-1001.step"',
    'Content-Disposition: attachment; filename="P-1001.step"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("ISO-10303-21;").toString("base64"),
    "--B--",
    "",
  ].join("\r\n");

  test("an email keeps its attachments as files", async () => {
    const read = await readRfqFile("rfq.eml", bytes(eml));
    expect(read.source).toBe("email");
    expect(read.files.map((f) => f.name)).toEqual(["P-1001.step"]);
    expect(new TextDecoder().decode(read.files[0].bytes)).toBe("ISO-10303-21;");
  });

  test("an upload reads the text it can and keeps every file", async () => {
    const read = await readRfqUpload([
      { name: "rfq.txt", bytes: bytes("Please quote 20 pcs of P-9 rev A") },
      { name: "P-9.stp", bytes: bytes("ISO-10303-21;") },
    ]);
    expect(read.source).toBe("upload");
    expect(read.body).toContain("P-9 rev A");
    expect(read.files.map((f) => f.name)).toEqual(["rfq.txt", "P-9.stp"]);
  });

  test("a saved email in an upload sets the sender and channel", async () => {
    const read = await readRfqUpload([{ name: "rfq.eml", bytes: bytes(eml) }]);
    expect(read).toMatchObject({ source: "email", subject: "RFQ brackets" });
    expect(read.files.map((f) => f.name)).toEqual(["P-1001.step"]);
  });

  test("models only: the RFQ lists its files instead of failing", async () => {
    const read = await readRfqUpload([
      { name: "P-9.stp", bytes: bytes("ISO-10303-21;") },
    ]);
    expect(read.body).toContain("- P-9.stp");
  });

  test("refuses files that aren't part of an RFQ package", async () => {
    await expect(
      readRfqUpload([{ name: "setup.exe", bytes: bytes("MZ") }])
    ).rejects.toThrow(SETUP_EXE);
  });
});
