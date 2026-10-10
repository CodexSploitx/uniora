import type { SessionAttributeName } from "./attributes.js";
import type { AttributeValue } from "./types.js";

/**
 * What your server's authentication knows about how the person signed in. UNIORA cannot check any of it: derive it from the verified
 * session or token (for an OpenID Connect token: `auth_time`, `amr`, `acr`), never from something the browser sent. Every field is
 * optional; a policy that needs one the host did not give is indeterminate, which refuses.
 *
 * ```ts
 * session: { authenticatedAt: new Date(claims.auth_time * 1000), mfa: claims.amr.includes("mfa"), methods: claims.amr }
 * ```
 */
export interface AuthorizeSession {
  /** When the person last proved who they are (a sign-in or a step-up), NOT when the session began. A `Date`: convert epoch seconds yourself. */
  authenticatedAt?: Date;
  /** When the session began. */
  startedAt?: Date;
  /** Whether a second factor was used. */
  mfa?: boolean;
  /** An integer from 0 to 100. */
  assuranceLevel?: number;
  /** At most 16 methods of 1 to 64 characters from `A-Z a-z 0-9 _ . : -`. */
  methods?: readonly string[];
}

export const MAX_SESSION_METHODS = 16;
export const MAX_ASSURANCE_LEVEL = 100;
/** A moment this far ahead of the engine's clock is clock skew; further than that the date is not believed. */
export const MAX_CLOCK_SKEW_MS = 60_000;

const FIELDS = ["authenticatedAt", "startedAt", "mfa", "assuranceLevel", "methods"] as const;
const METHOD_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export type SessionFacts = Partial<Record<SessionAttributeName, AttributeValue>>;

const isDate = (value: unknown): value is Date => Object.prototype.toString.call(value) === "[object Date]";

/**
 * Turns what the host passed into the facts a policy can read, or `undefined` when its shape is not acceptable (the decision is then
 * `malformed_input`, a deny: a session description that cannot be read must not be treated as "no information").
 * The ages are computed here from `nowMs`, the engine's clock; a date from the future beyond the clock-skew allowance, or an age
 * when the clock is unavailable, simply leaves that attribute out (unknown), so the policy that reads it is indeterminate.
 */
export function readSession(raw: unknown, nowMs: number | undefined): SessionFacts | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(raw).length > 0) return undefined;
  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!(FIELDS as readonly string[]).includes(key)) return undefined;
  const read = (name: (typeof FIELDS)[number]): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (descriptor === undefined) return undefined;
    return "value" in descriptor ? descriptor.value : Symbol("accessor");
  };
  const facts: SessionFacts = {};

  for (const [field, attribute] of [["authenticatedAt", "session.authAgeSeconds"], ["startedAt", "session.ageSeconds"]] as const) {
    const value = read(field);
    if (value === undefined) continue;
    if (!isDate(value)) return undefined;
    let at: number;
    try {
      at = Date.prototype.getTime.call(value) as number;
    } catch {
      // An object that only claims to be a Date (a forged Symbol.toStringTag).
      return undefined;
    }
    if (!Number.isFinite(at)) return undefined;
    if (nowMs === undefined || at > nowMs + MAX_CLOCK_SKEW_MS) continue;
    facts[attribute] = Math.max(0, Math.floor((nowMs - at) / 1000));
  }
  const mfa = read("mfa");
  if (mfa !== undefined) {
    if (typeof mfa !== "boolean") return undefined;
    facts["session.mfa"] = mfa;
  }
  const level = read("assuranceLevel");
  if (level !== undefined) {
    if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > MAX_ASSURANCE_LEVEL) return undefined;
    facts["session.assuranceLevel"] = level;
  }
  const methods = read("methods");
  if (methods !== undefined) {
    if (!Array.isArray(methods) || methods.length > MAX_SESSION_METHODS) return undefined;
    const list: string[] = [];
    for (let index = 0; index < methods.length; index++) {
      const method: unknown = (methods as unknown[])[index];
      if (typeof method !== "string" || !METHOD_PATTERN.test(method)) return undefined;
      if (!list.includes(method)) list.push(method);
    }
    facts["session.methods"] = list;
  }
  return facts;
}
