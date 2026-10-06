import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "uniora_studio_session";

/** Constant-time comparison (hashes first so length differences don't leak). */
export function tokensMatch(supplied: string, expected: string): boolean {
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * What the session cookie holds. NOT the launch token itself (audit F-08): a cookie that is the
 * secret would let anything that ever sees the cookie (a backup of the browser profile, a proxy
 * log) replay the launch URL's authority. This is an HMAC of a fixed label keyed by the token, so
 * the cookie proves knowledge of the token without revealing it.
 */
export function sessionCookieValue(token: string): string {
  return createHmac("sha256", token).update("uniora-studio-session-v1").digest("hex");
}

/** Constant-time check of a presented session cookie against the launch token. */
export function sessionMatches(cookie: string, token: string): boolean {
  return tokensMatch(cookie, sessionCookieValue(token));
}

/** The session cookie dies after this long even if the browser stays open (seconds). */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * DNS-rebinding defense: Studio only answers requests whose Host header is a
 * loopback name (and, when known, the exact port it was launched on).
 */
export function isAllowedHost(hostHeader: string | null, expectedPort: string | undefined): boolean {
  if (!hostHeader) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.toLowerCase());
  if (!match) return false;
  const [, hostname, port] = match;
  if (!hostname || !LOOPBACK_HOSTS.has(hostname)) return false;
  if (expectedPort && port !== expectedPort) return false;
  return true;
}
