import type { Identity } from "../identity/types.js";
import type { IdentityLink } from "./types.js";

export class IdentityLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityLinkError";
  }
}

export interface LinkIdentityInput {
  /** The new/alias identity being linked (e.g. a freshly migrated Clerk id). */
  from: Identity;
  /** The existing identity that already owns the membership(s) to keep using. */
  to: Identity;
  /**
   * Who performed the link. Actually recorded — `link()` writes a global
   * audit log entry (`action: "identity_link.created"`, no `organizationId`
   * since a link isn't scoped to one organization) on every real creation,
   * using this value as the entry's `actor`. This is the one Core primitive
   * that self-audits (see the class-level doc below for why).
   */
  actor: Identity;
}

/**
 * Cross-provider identity linking (docs/PROYECT.md §14-15).
 *
 * **Trust boundary — read before calling `link()`.** This repository has no
 * way to verify that `from` and `to` are controlled by the same real person:
 * Core is framework/adapter independent and never sees an HTTP request or a
 * login flow. The caller (the host application) MUST have already verified,
 * in the same authenticated session, that the current actor freshly proved
 * control of BOTH identities (e.g. is logged in via the old provider AND
 * just completed a real login with the new provider) before calling this.
 * Calling `link()` with an unverified `from`/`to` pair is an account
 * takeover vector — there is no email/username shortcut that is safe here
 * (see docs/supabase.md and the security skill §15/§16). Because this is the
 * single most dangerous primitive in Core, `link()` writes its own audit log
 * entry on every real creation (global, no `organizationId`) instead of
 * relying entirely on the caller to remember one — every other mutation in
 * Core leaves auditing up to the caller (see `docs/security-pentest-2026-09-24.md`
 * Hallazgo 5).
 */
export interface IdentityLinkRepository {
  /**
   * Links `from` to `to`. Rejects (fail-closed) rather than silently
   * merging when the request is ambiguous or looks like a hijack attempt:
   * - `from` already owns a membership directly, in any organization.
   * - `from` is already linked to a *different* `to` (linking again with
   *   the exact same `to` is idempotent and returns the existing link).
   * - `to` is itself a `from` of another link (no chains in V1).
   * - `from` is itself the `to` of another link (no chains in V1, the
   *   symmetric case — otherwise a chain could be built by construction
   *   order even though the case above blocks the same chain the other way;
   *   see `docs/security-pentest-2026-09-24.md` Hallazgo 6).
   * - `from` and `to` are the same identity.
   */
  link(input: LinkIdentityInput): Promise<IdentityLink>;
  /** Follows at most one hop. Returns `identity` unchanged if it has no link. */
  resolve(identity: Identity): Promise<Identity>;
}
