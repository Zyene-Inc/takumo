// @vitest-environment node
// Documents by email against a real database (F6.2-R1): mail to the shop's
// docs-…@ address is taken from its own people only, each attachment is
// read like an upload, and the sender gets a reply listing what it became.
// Runs only with TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DOMAIN = "in.test.example";
const DOCS_ADDRESS = /^docs-[a-z0-9]{12}@/;

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/auth/server", () => ({
  // The same membership, as the Knowledge Hub's viewers read it.
  shopRole: async (userId: string) =>
    userId === "user_sam" ? "operator" : null,
  listShopMembers: async () => [
    {
      id: "m1",
      userId: "user_sam",
      role: "operator",
      email: "sam@shop.example",
      name: "Sam",
    },
  ],
}));
const emails: { to: string; subject: string; text: string }[] = [];
vi.mock("@repo/email", () => ({
  resend: {
    emails: {
      send: (m: { to: string; subject: string; text: string }) => {
        emails.push(m);
        return Promise.resolve({ data: { id: "e1" } });
      },
    },
  },
}));
vi.mock("@repo/email/keys", () => ({
  keys: () => ({ RESEND_FROM: "takumo@test.example" }),
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../lib/billing", () => ({ featureProblem: async () => null }));
vi.mock("../lib/ai-usage", () => ({
  budgetProblem: async () => null,
  recordUsage: vi.fn(),
}));
// No AI in tests: reading a document reports what the real pipeline would.
const ingestDocument = vi.fn();
vi.mock("../lib/knowledge/ingest", () => ({
  ingestDocument: (...args: unknown[]) => ingestDocument(...args),
}));

type Process = typeof import("../lib/inbound/process");
type Db = typeof import("@repo/database");

const eml = (from: string, files: string[]) => {
  const boundary = "b1";
  const parts = files.map(
    (name) =>
      `--${boundary}\r\nContent-Type: application/pdf; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from("%PDF-1.4 setup sheet").toString("base64")}\r\n`
  );
  return new TextEncoder().encode(
    `From: ${from}\r\nTo: docs@x\r\nSubject: Setup sheet\r\nMessage-ID: <m-${randomUUID()}@shop.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\nHere you go\r\n${parts.join("")}--${boundary}--\r\n`
  );
};

const PASS = {
  spf: "pass",
  dkim: "pass",
  dmarc: "pass",
  dkimDomains: ["shop.example"],
  from: null,
};

describe.skipIf(!TEST_DATABASE_URL)("documents by email (database)", () => {
  const orgId = `org_docs_${randomUUID().slice(0, 8)}`;
  let database: Db["database"];
  let inbound: Process;
  let address = "";
  /** The shop's Public folder, where emailed documents go. */
  const publicFolder = async () => {
    const { publicFolderId } = await import("../lib/library/folders");
    return publicFolderId(orgId);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.INBOUND_EMAIL_DOMAIN = DOMAIN;
    process.env.SKIP_ENV_VALIDATION = "true";
    ({ database } = await import("@repo/database"));
    inbound = await import("../lib/inbound/process");
    await database.org.create({ data: { id: orgId, name: "Docs test" } });
    const addresses = await inbound.ensureAddresses(orgId);
    const docs = addresses.find((a) => a.kind === "docs");
    address = `docs-${docs?.token}@${DOMAIN}`;
    ingestDocument.mockImplementation(
      (
        _org: string,
        _user: string,
        file: { name: string },
        emit: (e: object) => void
      ) => {
        emit({ type: "step", text: `Reading ${file.name}` });
        emit({ type: "step", text: "Linked to your records: P-1001 rev A" });
        emit({
          type: "done",
          name: file.name.replace(".pdf", ""),
          facts: ["F-7"],
          linked: 1,
          passages: 2,
        });
        return Promise.resolve({
          sourceId: "s1",
          name: file.name,
          facts: ["F-7"],
        });
      }
    );
  });

  afterAll(async () => {
    await database?.org.deleteMany({ where: { id: orgId } });
  });

  test("the shop gets a docs address", () => {
    expect(address).toMatch(DOCS_ADDRESS);
  });

  test("someone outside the shop is bounced", async () => {
    const result = await inbound.receiveMessage({
      raw: eml("stranger@other.example", ["a.pdf"]),
      mailFrom: "stranger@other.example",
      recipients: [address],
      auth: { ...PASS, dkimDomains: ["other.example"] },
    });
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: expect.stringContaining("isn't someone in this shop"),
    });
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  test("a member's documents are read and the reply lists them", async () => {
    const raw = eml("Sam <sam@shop.example>", ["Setup P-1001.pdf"]);
    const result = await inbound.receiveMessage({
      raw,
      mailFrom: "sam@shop.example",
      recipients: [address],
      auth: PASS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [accepted] = result.accepted;
    expect(accepted?.kind).toBe("docs");
    if (!accepted) {
      return;
    }
    await inbound.processMessage(accepted, raw);
    // An emailed document is a new document, never a replacement.
    expect(ingestDocument).toHaveBeenCalledWith(
      orgId,
      "user_sam",
      expect.objectContaining({ name: "Setup P-1001.pdf" }),
      expect.any(Function),
      // Into Public, as an upload with no folder chosen goes.
      { via: "email", folderId: await publicFolder(), hidden: false }
    );
    const reply = emails.at(-1);
    expect(reply).toMatchObject({
      to: "sam@shop.example",
      subject: "Re: Setup sheet",
    });
    expect(reply?.text).toContain("Linked to your records: P-1001 rev A");
    expect(reply?.text).toContain("1 fact proposed for review: F-7");
    const message = await database.inboundMessage.findUniqueOrThrow({
      where: { id: accepted.messageId },
    });
    expect(message.status).toBe("processed");
    expect(message.detail).toMatchObject({
      documents: ["Setup P-1001: 1 fact proposed"],
      emailed: true,
    });
  });

  /** Send an email from Sam and process it; the stored message's status. */
  const sendFromSam = async (files: string[]) => {
    const raw = eml("Sam <sam@shop.example>", files);
    const result = await inbound.receiveMessage({
      raw,
      mailFrom: "sam@shop.example",
      recipients: [address],
      auth: PASS,
    });
    const accepted = result.ok ? result.accepted[0] : undefined;
    if (!accepted) {
      throw new Error("The email wasn't accepted.");
    }
    await inbound.processMessage(accepted, raw);
    return database.inboundMessage.findUniqueOrThrow({
      where: { id: accepted.messageId },
    });
  };

  test("an operator can't replace a document by email, whatever the extension", async () => {
    // Where emailed documents go: a clash there is what can't be replaced.
    const existing = await database.source.create({
      data: {
        orgId,
        name: "SOP-12",
        type: "upload",
        profile: "document",
        folderId: await publicFolder(),
      },
    });
    ingestDocument.mockClear();
    const message = await sendFromSam(["SOP-12.pdf", "SOP-12.docx"]);
    expect(ingestDocument).not.toHaveBeenCalled();
    expect(message.status).toBe("failed");
    expect(emails.at(-1)?.text).toContain(
      "Couldn't read it: there's already a document with this name."
    );
    expect(
      await database.source.findMany({
        where: { orgId, name: "SOP-12" },
        select: { id: true },
      })
    ).toEqual([{ id: existing.id }]);
  });

  test("a document that arrives while the email is read is reported, not replaced", async () => {
    const { DocumentExistsError } = await import("../lib/knowledge/documents");
    ingestDocument.mockImplementationOnce(() =>
      Promise.reject(new DocumentExistsError("Late sheet"))
    );
    const message = await sendFromSam(["Late sheet.pdf"]);
    expect(message.status).toBe("failed");
    expect(message.detail).toMatchObject({
      documents: [
        "Late sheet.pdf: there's already a document with this name. Rename the file and send it again.",
      ],
    });
  });
});
