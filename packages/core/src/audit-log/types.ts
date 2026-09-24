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
  readonly organizationId: string;
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
