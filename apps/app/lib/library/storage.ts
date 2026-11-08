import "server-only";

import { env } from "@/env";

// Original documents in a private Supabase Storage bucket. Only the server
// talks to Storage, with the service-role key, and only after Takumo has
// decided who may see the file; people get a link that works for a minute.
// Keys are built here from database ids, never from anything a request says,
// so a path can't decide what someone is allowed to read.

/** How long a download or preview link works. */
export const SIGNED_URL_SECONDS = 60;

export interface ObjectStore {
  /** The stored bytes; throws StorageError when they can't be read. */
  get(key: string): Promise<Uint8Array>;
  /** Store bytes. Storing the same key again is not an error (keys name content). */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Delete; keys already gone are not an error. */
  remove(keys: string[]): Promise<void>;
  /** A link to the file that expires; `downloadAs` makes it a download. */
  signedUrl(
    key: string,
    options: { downloadAs?: string; seconds: number }
  ): Promise<string>;
}

/** Storage failed. The message is safe to log; it never holds a key or secret. */
export class StorageError extends Error {
  constructor(operation: string, status?: number) {
    super(
      `Document storage ${operation} failed${status ? ` (${status})` : ""}`
    );
    this.name = "StorageError";
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TRAILING_SLASHES = /\/+$/;
const SHA256 = /^[0-9a-f]{64}$/;

const checkId = (what: string, value: string) => {
  if (!SAFE_ID.test(value)) {
    throw new Error(`Not a valid ${what} for a storage key.`);
  }
};

/** Everything stored for one document, all versions: org/<org>/src/<id>/. */
export const documentPrefix = (orgId: string, sourceId: string) => {
  checkId("shop id", orgId);
  checkId("document id", sourceId);
  return `org/${orgId}/src/${sourceId}/`;
};

/** Where a version's original file is kept. */
export const originalKey = (
  orgId: string,
  sourceId: string,
  version: number,
  sha256: string
) => {
  if (!(Number.isInteger(version) && version >= 1 && SHA256.test(sha256))) {
    throw new Error("Not a valid version for a storage key.");
  }
  return `${documentPrefix(orgId, sourceId)}v${version}/${sha256}`;
};

/** A stored key really is under this shop's document (checked before signing). */
export const keyBelongsTo = (key: string, orgId: string, sourceId: string) =>
  key.startsWith(documentPrefix(orgId, sourceId)) && !key.includes("..");

const encodePath = (key: string) =>
  key.split("/").map(encodeURIComponent).join("/");

/** Supabase Storage over its REST API (no client library needed). */
const supabaseStore = (
  url: string,
  serviceKey: string,
  bucket: string
): ObjectStore => {
  const base = `${url.replace(TRAILING_SLASHES, "")}/storage/v1`;
  const headers = {
    authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
  };
  const object = (key: string) =>
    `${base}/object/${encodeURIComponent(bucket)}/${encodePath(key)}`;

  return {
    async put(key, bytes, contentType) {
      const response = await fetch(object(key), {
        method: "POST",
        headers: {
          ...headers,
          "content-type": contentType,
          "x-upsert": "false",
          "cache-control": "no-store",
        },
        body: new Uint8Array(bytes),
      });
      // 409: already there. The key names the content (its sha256), so the
      // same key means the same bytes.
      if (!(response.ok || response.status === 409)) {
        throw new StorageError("upload", response.status);
      }
    },
    async get(key) {
      const response = await fetch(object(key), { headers });
      if (!response.ok) {
        throw new StorageError("read", response.status);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async remove(keys) {
      if (keys.length === 0) {
        return;
      }
      const response = await fetch(
        `${base}/object/${encodeURIComponent(bucket)}`,
        {
          method: "DELETE",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prefixes: keys }),
        }
      );
      if (!response.ok) {
        throw new StorageError("delete", response.status);
      }
    },
    async signedUrl(key, { seconds, downloadAs }) {
      const response = await fetch(
        `${base}/object/sign/${encodeURIComponent(bucket)}/${encodePath(key)}`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ expiresIn: seconds }),
        }
      );
      if (!response.ok) {
        throw new StorageError("link", response.status);
      }
      const { signedURL } = (await response.json()) as { signedURL?: string };
      if (!signedURL) {
        throw new StorageError("link");
      }
      const link = new URL(`${base}${signedURL}`);
      if (downloadAs) {
        link.searchParams.set("download", downloadAs);
      }
      return link.toString();
    },
  };
};

const DEFAULT_BUCKET = "company-documents";

/**
 * The store for original documents, or null when Storage isn't set up (then
 * documents are still read and searched, but no original is kept).
 */
export const objectStore = (): ObjectStore | null => {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!(url && key)) {
    return null;
  }
  return supabaseStore(url, key, env.KNOWLEDGE_BUCKET ?? DEFAULT_BUCKET);
};
