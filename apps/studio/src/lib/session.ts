import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getStudioEnv } from "@/lib/env";
import { SESSION_COOKIE, tokensMatch } from "@/lib/token";

export class StudioAuthError extends Error {
  constructor(message = "invalid session") {
    super(message);
    this.name = "StudioAuthError";
  }
}

export class StudioReadOnlyError extends Error {
  constructor() {
    super("read-only");
    this.name = "StudioReadOnlyError";
  }
}

/**
 * Independent re-check behind proxy.ts (defense in depth, INV-010): every
 * data read and every Server Action verifies the session itself instead of
 * trusting that the proxy already ran.
 */
export async function requireSession(): Promise<void> {
  // Studio's pages depend on the running process' environment and the request's
  // cookie, so they must never be prerendered at build time.
  await connection();
  const { token } = getStudioEnv();
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie || !tokensMatch(cookie, token)) throw new StudioAuthError();
}

export async function requireWrite(): Promise<void> {
  await requireSession();
  if (getStudioEnv().readOnly) throw new StudioReadOnlyError();
}

export function isReadOnly(): boolean {
  return getStudioEnv().readOnly;
}

export function getDefaultAuthProvider(): string | undefined {
  return getStudioEnv().defaultAuthProvider;
}
