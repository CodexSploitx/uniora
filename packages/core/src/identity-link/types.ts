import type { Identity } from "../identity/types.js";

/**
 * States that `from` is an alias of `to`: any lookup by `from` should
 * transparently resolve to `to` (docs/PROYECT.md §14-15 — the auth provider
 * can change, but the organization/membership must not be lost).
 *
 * Single-hop only: `to` must never itself be a `from` of another link (no
 * chains) — see `IdentityLinkRepository.link`.
 */
export interface IdentityLink {
  readonly from: Identity;
  readonly to: Identity;
  readonly linkedAt: Date;
}
