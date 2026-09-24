import type { Identity } from "../identity/types.js";
import type { AuditLogEntry, AuditLogTarget } from "./types.js";

export interface RecordAuditLogInput {
  id: string;
  organizationId: string;
  actor: Identity;
  action: string;
  target?: AuditLogTarget;
  metadata?: Record<string, unknown>;
}

export interface ListAuditLogOptions {
  limit?: number;
  /**
   * Keyset cursor (see `AuditLogCursor`) — only entries strictly older than
   * this `(createdAt, id)` pair are returned. Never `offset`: the log keeps
   * growing underneath any given page.
   */
  before?: AuditLogCursor;
}

/**
 * Keyset cursor for `listRecent` — strictly-older-than the given
 * `(createdAt, id)` pair. A plain `offset` would re-scan and could skip or
 * repeat rows if new entries are recorded between pages (audit logs are
 * append-only and grow constantly); a keyset cursor doesn't have that
 * problem. `id` is only a tiebreaker for entries with the same millisecond
 * timestamp — it carries no ordering meaning of its own.
 */
export interface AuditLogCursor {
  createdAt: Date;
  id: string;
}

export interface ListRecentAuditLogOptions {
  limit?: number;
  before?: AuditLogCursor;
}

/**
 * Append-only by design (security skill §26/§70): this interface has no
 * update or delete method, so an adapter cannot expose a way to alter or
 * erase security audit history — only to add to it and to read it.
 */
export interface AuditLogRepository {
  record(input: RecordAuditLogInput): Promise<AuditLogEntry>;
  listByOrganization(organizationId: string, options?: ListAuditLogOptions): Promise<AuditLogEntry[]>;
  /**
   * The most recent entries across **every** organization, newest first —
   * for a global activity view (e.g. an admin tool like Studio), never
   * exposed to a tenant-scoped caller. Paginate with `before` (see
   * `AuditLogCursor`), not `offset`.
   */
  listRecent(options?: ListRecentAuditLogOptions): Promise<AuditLogEntry[]>;
}
