/**
 * Token generation and hashing over Web Crypto (`globalThis.crypto`): present
 * in Node 19+, edge runtimes and browsers, so Core keeps zero runtime
 * dependencies and no Node-only imports.
 */

interface WebCrypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID(): string;
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}

function webCrypto(): WebCrypto {
  const candidate = (globalThis as { crypto?: WebCrypto }).crypto;
  if (!candidate?.subtle || typeof candidate.getRandomValues !== "function") {
    throw new Error("@uniora/core needs Web Crypto (globalThis.crypto) to issue invitations — use Node 19+.");
  }
  return candidate;
}

/** Prefix that makes a leaked token recognizable to secret scanners and humans. */
export const INVITATION_TOKEN_PREFIX = "uinv_";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 256 bits from the platform CSPRNG. */
export function generateInvitationToken(): string {
  const bytes = webCrypto().getRandomValues(new Uint8Array(32));
  return INVITATION_TOKEN_PREFIX + toBase64Url(bytes);
}

/** The only form of a token that is ever persisted. High-entropy input, so a plain SHA-256 is the right tool. */
export async function hashInvitationToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  return toHex(await webCrypto().subtle.digest("SHA-256", data));
}

export function randomId(): string {
  return webCrypto().randomUUID();
}
