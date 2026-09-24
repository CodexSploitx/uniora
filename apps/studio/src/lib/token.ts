import { createHash, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "uniora_studio_session";

/** Constant-time comparison (hashes first so length differences don't leak). */
export function tokensMatch(supplied: string, expected: string): boolean {
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

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
