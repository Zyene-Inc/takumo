// Connector secrets at rest, and the OAuth `state` that ties a callback to the
// shop and person who started it. Pure (keys passed in), so tested.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** CONNECTOR_ENCRYPTION_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). */
export const parseKey = (base64: string | undefined) => {
  const key = base64 ? Buffer.from(base64, "base64") : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new Error(
      "CONNECTOR_ENCRYPTION_KEY must be 32 bytes, base64 (openssl rand -base64 32)."
    );
  }
  return key;
};

/** AES-256-GCM: "v1:<iv>:<tag>:<ciphertext>", each base64url. */
export const encrypt = (key: Buffer, plaintext: string) => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((part) =>
      typeof part === "string" ? part : part.toString("base64url")
    )
    .join(":");
};

export const decrypt = (key: Buffer, sealed: string) => {
  const [version, iv, tag, data] = sealed.split(":");
  const authTag = Buffer.from(tag ?? "", "base64url");
  if (
    version !== VERSION ||
    !(iv && data) ||
    authTag.length !== AUTH_TAG_BYTES
  ) {
    throw new Error("Not an encrypted connector secret.");
  }
  // A full-length tag only: a shortened one would be far easier to forge.
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
    { authTagLength: AUTH_TAG_BYTES }
  );
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

export interface OAuthState {
  exp: number;
  nonce: string;
  orgId: string;
  provider: string;
  userId: string;
}

/** Minutes a person has to finish connecting. */
export const STATE_MINUTES = 15;

const sign = (key: Buffer, body: string) =>
  createHmac("sha256", key).update(`oauth-state.${body}`).digest("base64url");

export const signState = (
  key: Buffer,
  state: Omit<OAuthState, "exp" | "nonce">,
  now = Date.now()
) => {
  const body = Buffer.from(
    JSON.stringify({
      ...state,
      exp: now + STATE_MINUTES * 60_000,
      nonce: randomBytes(9).toString("base64url"),
    })
  ).toString("base64url");
  return `${body}.${sign(key, body)}`;
};

/** The state if it's genuine and fresh, else null. */
export const verifyState = (
  key: Buffer,
  token: string,
  now = Date.now()
): OAuthState | null => {
  const [body, mac] = token.split(".");
  if (!(body && mac)) {
    return null;
  }
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  try {
    const state = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as OAuthState;
    return state.exp > now ? state : null;
  } catch {
    return null;
  }
};
