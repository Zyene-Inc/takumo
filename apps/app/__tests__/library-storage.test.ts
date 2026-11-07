// @vitest-environment node
// Original-file storage for the Knowledge Hub, without a database or a real
// Supabase project: what counts as a real document, how storage keys are
// built (only from ids, never from a request), and what the Supabase
// adapter sends. The service key and file names never end up in errors.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const settings = vi.hoisted(() => ({
  SUPABASE_URL: "https://project.supabase.test/" as string | undefined,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-0123456789" as
    | string
    | undefined,
  KNOWLEDGE_BUCKET: undefined as string | undefined,
}));
vi.mock("@/env", () => ({ env: settings }));

const { checkDocumentFile, sha256Hex } = await import("../lib/library/files");
const storage = await import("../lib/library/storage");

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name)));
const text = (s: string) => new TextEncoder().encode(s);

describe("what counts as a document", () => {
  test.each([
    ["sample.pdf", fixture("sample.pdf"), "application/pdf"],
    [
      "sample.docx",
      fixture("sample.docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["notes.txt", text("Plain words, café."), "text/plain"],
    ["notes.md", text("# Heading"), "text/markdown"],
    ["parts.csv", text("part,qty\nP-1,2"), "text/csv"],
    ["photo.JPG", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]), "image/jpeg"],
    [
      "scan.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      "image/png",
    ],
  ])("%s is accepted as %s", (name, bytes, mimeType) => {
    expect(checkDocumentFile(name, bytes)).toEqual({
      ok: true,
      mimeType: expect.stringMatching(/./),
      size: bytes.length,
    });
    const check = checkDocumentFile(name, bytes);
    expect(check.ok && check.mimeType).toBe(mimeType);
  });

  test.each([
    ["a text file renamed .pdf", "a.pdf", text("hello")],
    ["a PDF renamed .docx", "a.docx", fixture("sample.pdf")],
    ["a Word file renamed .pdf", "a.pdf", fixture("sample.docx")],
    ["a zip that isn't Word", "a.docx", new Uint8Array([0x50, 0x4b, 3, 4])],
    ["binary renamed .csv", "a.csv", new Uint8Array([1, 0, 2])],
    ["invalid UTF-8 as .txt", "a.txt", new Uint8Array([0xc3, 0x28])],
    ["a PNG renamed .jpg", "a.jpg", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ["an HTML page", "a.html", text("<script>")],
    ["an SVG", "a.svg", text("<svg/>")],
    ["no extension", "README", text("hi")],
    ["empty", "a.txt", new Uint8Array()],
  ])("%s is refused", (_, name, bytes) => {
    expect(checkDocumentFile(name, bytes).ok).toBe(false);
  });

  test("the size limit is 20 MB", () => {
    expect(
      checkDocumentFile("big.txt", new Uint8Array(20 * 1024 * 1024).fill(65)).ok
    ).toBe(true);
    expect(
      checkDocumentFile("big.txt", new Uint8Array(20 * 1024 * 1024 + 1)).ok
    ).toBe(false);
  });

  test("the hash is the file's SHA-256", () => {
    expect(sha256Hex(text("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("storage keys", () => {
  const sha = "a".repeat(64);

  test("are built from the shop, document, version and content hash", () => {
    expect(storage.originalKey("org_01ABC", "src-1", 3, sha)).toBe(
      `org/org_01ABC/src/src-1/v3/${sha}`
    );
    expect(storage.documentPrefix("org_01ABC", "src-1")).toBe(
      "org/org_01ABC/src/src-1/"
    );
  });

  test.each([
    ["../other", "src", 1, sha],
    ["org", "src/../x", 1, sha],
    ["org", "src", 0, sha],
    ["org", "src", 1.5, sha],
    ["org", "src", 1, "../../etc"],
    ["", "src", 1, sha],
  ])("refuse anything that could escape its place (%s, %s, %s)", (o, s, v, h) => {
    expect(() => storage.originalKey(o, s, v, h)).toThrow();
  });

  test("a key is checked against the shop and document it must belong to", () => {
    const key = storage.originalKey("org_a", "doc1", 1, sha);
    expect(storage.keyBelongsTo(key, "org_a", "doc1")).toBe(true);
    expect(storage.keyBelongsTo(key, "org_b", "doc1")).toBe(false);
    expect(storage.keyBelongsTo(key, "org_a", "doc2")).toBe(false);
    expect(storage.keyBelongsTo(key, "org_a", "doc")).toBe(false);
    expect(
      storage.keyBelongsTo("org/org_a/src/doc1/../../org_b/x", "org_a", "doc1")
    ).toBe(false);
  });
});

describe("the Supabase adapter", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    settings.SUPABASE_URL = "https://project.supabase.test/";
    settings.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret-0123456789";
    settings.KNOWLEDGE_BUCKET = undefined;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const store = () => {
    const s = storage.objectStore();
    if (!s) {
      throw new Error("expected a store");
    }
    return s;
  };

  test("there is no store unless the server has its URL and key", () => {
    settings.SUPABASE_SERVICE_ROLE_KEY = undefined;
    expect(storage.objectStore()).toBeNull();
  });

  test("uploads go to the private bucket with the service key, never overwriting", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await store().put("org/o/src/s/v1/abc", text("x"), "application/pdf");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://project.supabase.test/storage/v1/object/company-documents/org/o/src/s/v1/abc"
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer service-role-secret-0123456789",
      "content-type": "application/pdf",
      "x-upsert": "false",
    });
  });

  test("storing the same content again is not an error; other failures are", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 409 }));
    await expect(store().put("k", text("x"), "text/plain")).resolves.toBe(
      undefined
    );
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const failure = await store()
      .put("org/secret-name/k", text("x"), "text/plain")
      .catch((e: Error) => e);
    expect(failure).toBeInstanceOf(storage.StorageError);
    expect(String(failure)).not.toContain("secret");
    expect(String(failure)).not.toContain("org/");
  });

  test("links expire and name the download; the bucket comes from settings", async () => {
    settings.KNOWLEDGE_BUCKET = "shop-docs";
    fetchMock.mockResolvedValue(
      Response.json({ signedURL: "/object/sign/shop-docs/k?token=t" })
    );
    const link = await store().signedUrl("org/o/src/s/v1/k", {
      seconds: storage.SIGNED_URL_SECONDS,
      downloadAs: "Setup sheet.pdf",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://project.supabase.test/storage/v1/object/sign/shop-docs/org/o/src/s/v1/k"
    );
    expect(JSON.parse(init.body)).toEqual({ expiresIn: 60 });
    expect(link).toBe(
      "https://project.supabase.test/storage/v1/object/sign/shop-docs/k?token=t&download=Setup+sheet.pdf"
    );
  });

  test("deleting names the exact keys", async () => {
    fetchMock.mockResolvedValue(Response.json([]));
    await store().remove(["a/1", "a/2"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://project.supabase.test/storage/v1/object/company-documents"
    );
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ prefixes: ["a/1", "a/2"] });
    fetchMock.mockClear();
    await store().remove([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("path segments are encoded, so a name can't change the path", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1])));
    await store().get("org/o/src/s/v1/a b?c#d");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://project.supabase.test/storage/v1/object/company-documents/org/o/src/s/v1/a%20b%3Fc%23d"
    );
  });
});
