import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The format of an API key:
 *
 *   uniora_sk_<keyId>_<secret>_<checksum>
 *
 * - `uniora_sk_`: a fixed prefix, so secret scanners (GitHub's, your own) find a leaked key.
 * - `keyId`: 16 random base62 characters. Public: it is how the server finds the key, and it is safe to log.
 * - `secret`: 43 random base62 characters, about 256 bits. Shown once, never stored (only its SHA-256).
 * - `checksum`: CRC32 of everything before it, in 6 base62 characters. It lets the server and the client library reject a typo
 *   or a random string without touching the database, and gives scanners almost no false positives. It is NOT a secret and
 *   adds no security by itself.
 *
 * A fast hash is right for the stored digest: the secret has 256 bits of entropy, so there is nothing to brute-force. Slow
 * hashes (bcrypt, argon2) protect low-entropy passwords and would only add latency to every request.
 */
export const API_KEY_PREFIX = "uniora_sk_";
export const API_KEY_ID_LENGTH = 16;
export const API_KEY_SECRET_LENGTH = 43;
export const API_KEY_CHECKSUM_LENGTH = 6;
export const API_KEY_MAX_LENGTH = API_KEY_PREFIX.length + API_KEY_ID_LENGTH + 1 + API_KEY_SECRET_LENGTH + 1 + API_KEY_CHECKSUM_LENGTH;

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_PATTERN = new RegExp(
  `^${API_KEY_PREFIX}([0-9A-Za-z]{${API_KEY_ID_LENGTH}})_([0-9A-Za-z]{${API_KEY_SECRET_LENGTH}})_([0-9A-Za-z]{${API_KEY_CHECKSUM_LENGTH}})$`,
);

/** `length` uniformly random base62 characters (rejection sampling: no modulo bias). */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248) {
        out += ALPHABET[byte % 62];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function checksumOf(text: string): string {
  let value = crc32(text);
  let out = "";
  for (let i = 0; i < API_KEY_CHECKSUM_LENGTH; i++) {
    out = ALPHABET[value % 62] + out;
    value = Math.floor(value / 62);
  }
  return out;
}

export function hashApiKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface GeneratedApiKey {
  /** The public id of the key. */
  readonly id: string;
  /** The whole key, to hand to the caller ONCE. */
  readonly token: string;
  /** SHA-256 of the secret: the only thing that is stored. */
  readonly secretHash: string;
  /** The last four characters of the secret. */
  readonly hint: string;
}

export function generateApiKey(): GeneratedApiKey {
  const id = randomBase62(API_KEY_ID_LENGTH);
  const secret = randomBase62(API_KEY_SECRET_LENGTH);
  const body = `${API_KEY_PREFIX}${id}_${secret}`;
  return { id, token: `${body}_${checksumOf(body)}`, secretHash: hashApiKeySecret(secret), hint: secret.slice(-4) };
}

export interface ParsedApiKey {
  readonly id: string;
  readonly secret: string;
}

/**
 * The id and secret of a well-formed key, or `null`: wrong length, shape or checksum. It never touches storage, so a
 * malformed value costs nothing. Anything longer than a real key is rejected before the pattern runs.
 */
export function parseApiKey(token: unknown): ParsedApiKey | null {
  if (typeof token !== "string" || token.length !== API_KEY_MAX_LENGTH) return null;
  const match = KEY_PATTERN.exec(token);
  if (!match) return null;
  const [, id, secret, checksum] = match as unknown as [string, string, string, string];
  const body = `${API_KEY_PREFIX}${id}_${secret}`;
  const expected = Buffer.from(checksumOf(body));
  const given = Buffer.from(checksum);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { id, secret };
}

/** Compares a presented secret with the stored digest in constant time. */
export function verifyApiKeySecret(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKeySecret(secret), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/** `Authorization: Bearer <token>` → the token, or `undefined` (any other scheme, a missing token or extra parts). */
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1];
}
