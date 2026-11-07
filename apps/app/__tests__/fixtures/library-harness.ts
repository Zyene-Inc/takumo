// Shared by the Knowledge Hub document tests (library-*.db.test.ts): an
// in-memory object store standing in for Supabase Storage, a scripted reader
// standing in for text extraction and OCR, and the signed-in session. No
// app imports here, so each test file's vi.mock calls stay in charge.
import { vi } from "vitest";

export const DIMENSIONS = 1024;

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

/** Private storage in memory, with switches to make each operation fail. */
export const memoryStore = () => {
  const objects = new Map<string, StoredObject>();
  const fail = { put: false, get: false, remove: false };
  const store = {
    objects,
    fail,
    put: vi.fn(async (key: string, bytes: Uint8Array, contentType: string) => {
      if (fail.put) {
        throw Object.assign(new Error("Document storage upload failed (500)"), {
          name: "StorageError",
        });
      }
      objects.set(key, { bytes: new Uint8Array(bytes), contentType });
    }),
    get: vi.fn(async (key: string) => {
      const found = objects.get(key);
      if (fail.get || !found) {
        throw new Error("Document storage read failed (404)");
      }
      return found.bytes;
    }),
    remove: vi.fn(async (keys: string[]) => {
      if (fail.remove) {
        throw new Error("Document storage delete failed (503)");
      }
      for (const key of keys) {
        objects.delete(key);
      }
    }),
    signedUrl: vi.fn(
      async (key: string, o: { downloadAs?: string; seconds: number }) =>
        `https://storage.test/sign/${key}?expires=${o.seconds}${
          o.downloadAs ? `&download=${encodeURIComponent(o.downloadAs)}` : ""
        }`
    ),
  };
  return store;
};

export type MemoryStore = ReturnType<typeof memoryStore>;

interface ScriptedPage {
  page: number | null;
  /** Read by OCR (a scan) rather than from a text layer. */
  scanned?: boolean;
  text: string;
}

export const state = {
  store: null as MemoryStore | null,
  session: {
    orgId: "" as string | null,
    userId: "user_planner" as string | null,
    role: "planner" as string | null,
  },
  /** Active WorkOS memberships, "shop:user" → role. */
  memberships: new Map<string, string>(),
  /** Pages a file reads as, by file name; otherwise its bytes as one page. */
  pages: new Map<string, ScriptedPage[]>(),
  /** Scanned pages whose OCR fails, once each. */
  failOcr: new Set<number>(),
  /** Scanned pages OCR was asked to read, in order. */
  ocrCalls: [] as number[],
  /** How long OCR takes per scanned page, in ms. */
  ocrDelayMs: 0,
  /** Embedding calls still to fail. */
  embedFailures: 0,
  /** Facts the AI "finds" in each document, by text marker. */
  facts: [] as {
    attribute: string;
    partNo: string;
    quote: string;
    subjectType: string;
    value: string;
  }[],
};

export const resetState = () => {
  state.store = memoryStore();
  state.session = { orgId: "", userId: "user_planner", role: "planner" };
  state.pages.clear();
  state.failOcr.clear();
  state.ocrCalls.length = 0;
  state.embedFailures = 0;
  state.ocrDelayMs = 0;
  state.facts = [];
};

interface ReadOptions {
  known?: Map<number, string>;
  onProgress?: (done: number, total: number) => void;
  onRecognized?: (
    pages: { page: number | null; text: string }[]
  ) => Promise<void>;
}

/** Stands in for readDocument, honouring `known` and `onRecognized` like it. */
export const scriptedRead = async (
  _orgId: string,
  name: string,
  bytes: Uint8Array,
  options: ReadOptions = {}
) => {
  const pages = state.pages.get(name) ?? [
    { page: 1, text: new TextDecoder().decode(bytes) },
  ];
  const out: { page: number | null; text: string }[] = [];
  let recognized = 0;
  for (const p of pages) {
    if (!(p.scanned && p.page !== null)) {
      out.push({ page: p.page, text: p.text });
      continue;
    }
    recognized += 1;
    const known = options.known?.get(p.page);
    if (known !== undefined) {
      out.push({ page: p.page, text: known });
      continue;
    }
    if (state.failOcr.has(p.page)) {
      state.failOcr.delete(p.page);
      throw new Error("model provider timed out");
    }
    if (state.ocrDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, state.ocrDelayMs));
    }
    state.ocrCalls.push(p.page);
    out.push({ page: p.page, text: p.text });
    await options.onRecognized?.([{ page: p.page, text: p.text }]);
  }
  return { pages: out, recognized };
};

/** Vectors for embedMany, or a failure while embedFailures lasts. */
export const scriptedEmbedMany = ({ values }: { values: string[] }) => {
  if (state.embedFailures > 0) {
    state.embedFailures -= 1;
    return Promise.reject(new Error("embedding provider unavailable"));
  }
  return Promise.resolve({
    embeddings: values.map((_, i) =>
      Array.from({ length: DIMENSIONS }, (_, j) => (i + j + 1) / DIMENSIONS)
    ),
  });
};

/** A query's vector, for searchDocuments. */
export const scriptedEmbed = () =>
  Promise.resolve({
    embedding: Array.from(
      { length: DIMENSIONS },
      (_, j) => (j + 1) / DIMENSIONS
    ),
  });

export const text = (value: string) => new TextEncoder().encode(value);

export const pdf = (value: string) => text(`%PDF-1.7\n${value}`);

/** A browser upload of one file to a route. */
export const uploadRequest = (
  url: string,
  fileName: string,
  bytes: Uint8Array,
  extra: Record<string, string> = {}
) => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], fileName));
  for (const [key, value] of Object.entries(extra)) {
    form.set(key, value);
  }
  return new Request(url, { method: "POST", body: form });
};

/** Every event a streamed upload sent. */
export const events = async (response: Response) =>
  (await response.text())
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          error?: string;
          background?: boolean;
          facts?: string[];
          text?: string;
        }
    );
