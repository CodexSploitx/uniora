import type { Identity } from "../identity/types.js";

/**
 * Reference to the entity an audit action was performed on,
 * e.g. `{ type: "role", id: "role-admin" }`.
 */
export interface AuditLogTarget {
  readonly type: string;
  readonly id: string;
}

/**
 * A record of a security-sensitive operation (docs/PROYECT.md §31). Audit
 * logs are append-only by design — see `AuditLogRepository`, which exposes
 * no update/delete so an adapter can't accidentally allow tampering with
 * audit history.
 */
export interface AuditLogEntry {
  readonly id: string;
  /**
   * Absent for a GLOBAL entry — an operation with no single organization to
   * scope it to (e.g. `IdentityLinkRepository.link()`, which spans whatever
   * organizations the linked identities happen to have memberships in).
   * Never appears in `listByOrganization`, only in `listRecent`.
   */
  readonly organizationId?: string;
  readonly actor: Identity;
  readonly action: string;
  readonly target?: AuditLogTarget;
  /**
   * Free-form extra context. Callers must never put secrets here (passwords,
   * tokens, API keys, invitation secrets, session secrets) — this repository
   * has no way to redact what a caller chooses to store here.
   */
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: Date;
}

/**
 * Result of `AuditLogRepository.verifyIntegrity()`. Entries are hash-chained
 * (each one commits to the previous entry's hash), so editing or deleting a
 * row in the middle of the log is detectable. Truncating the END of the log
 * is not: keep `head` somewhere the database owner can't rewrite (a WORM
 * bucket, another system) and compare it later — see guides/hardening.md.
 */
export interface AuditIntegrityOptions {
  /** A `head` exported by an earlier run and stored out of the database owner's reach. */
  anchor?: { position: number; hash: string };
}

export interface AuditIntegrityReport {
  ok: boolean;
  /** Chained entries whose content and link were checked. */
  checked: number;
  /** The newest chained entry; export it periodically as an external anchor. */
  head?: { position: number; hash: string };
  /**
   * Only when `verifyIntegrity({ anchor })` was given: `valid` if the anchored position still holds
   * the anchored hash, `missing` if the log was truncated below it, `mismatch` if the history was
   * rewritten. Anything but `valid` makes `ok` false.
   */
  anchor?: "valid" | "missing" | "mismatch" | "pruned";
  /**
   * Present once old entries were removed by `pruneBefore` (retention): the chain is checked from the checkpoint
   * recorded then. `through` is the last removed entry (its position and hash), `removed` how many entries went in total.
   */
  pruned?: { through: { position: number; hash: string }; removed: number };
  /** The first entry that fails verification, when `ok` is false. */
  broken?: { id: string; reason: "content_mismatch" | "chain_broken" };
}
