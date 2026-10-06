import type { Identity } from "../identity/types.js";
import { UnioraError } from "../shared/errors.js";
import type { AuditIntegrityOptions, AuditIntegrityReport, AuditLogEntry, AuditLogTarget } from "./types.js";

/** Invalid input to the audit log. `code` is `audit_actor_required` or `audit_action_invalid`. */
export class AuditLogError extends UnioraError {
  constructor(message: string, code: "audit_actor_required" | "audit_action_invalid" | "audit_prune_invalid") {
    super(message, code);
    this.name = "AuditLogError";
  }
}

/**
 * Every entry must say WHO did it and WHAT: an empty actor or action is rejected before anything is written, in every
 * backend, so the trail never has a nameless entry. Returns the input for chaining.
 */
export function assertAuditInput<T extends { actor: Identity; action: string }>(input: T): T {
  const { actor } = input;
  if (
    typeof actor?.provider !== "string" || actor.provider.trim() === "" ||
    typeof actor?.subject !== "string" || actor.subject.trim() === ""
  ) {
    throw new AuditLogError("An audit entry needs an actor (provider and subject).", "audit_actor_required");
  }
  if (typeof input.action !== "string" || input.action.trim() === "" || input.action.length > 200) {
    throw new AuditLogError("An audit entry needs an action name of at most 200 characters.", "audit_action_invalid");
  }
  return input;
}

export interface PruneAuditLogInput {
  /** Entries created strictly before this instant are removed (never the newest entry, never the future). */
  before: Date;
  /** Who is pruning. Required: the removal is itself recorded in the log, with this actor. */
  actor: Identity;
}

export interface PruneAuditLogResult {
  /** How many entries were removed. `0` when nothing was old enough. */
  removed: number;
  /** The last removed entry, i.e. the new checkpoint the chain is verified from. */
  through?: { position: number; hash: string };
}

export interface RecordAuditLogInput {
  id: string;
  /** Omit for a GLOBAL entry with no single organization to scope it to — see `AuditLogEntry.organizationId`. */
  organizationId?: string;
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

export interface SearchAuditLogOptions {
  /** Only this organization's entries. Omit to search every organization (admin views only). */
  organizationId?: string;
  /** Exact action name, or any of several. */
  action?: string | string[];
  /** Every action starting with this text, e.g. `"membership."`. */
  actionPrefix?: string;
  /** Entries performed by this exact identity. */
  actor?: Identity;
  /** Entries about this object; omit `id` to match every object of that `type`. */
  target?: { type: string; id?: string };
  /** `createdAt >= since`. */
  since?: Date;
  /** `createdAt < until`. */
  until?: Date;
  limit?: number;
  /** Keyset cursor, as in `listRecent` — only entries strictly older than this `(createdAt, id)` pair. */
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
  /**
   * Filtered, keyset-paginated reading of the log, newest first: by organization, action (exact or prefix), actor,
   * target and time range, all combinable. Prefer it to `listByOrganization` / `listRecent` for any screen with filters.
   */
  search(options?: SearchAuditLogOptions): Promise<AuditLogEntry[]>;
  /**
   * Retention: removes the OLDEST entries (those created before `before`, never the newest one) and records a
   * checkpoint — the hash of the last removed entry — so the chain still verifies from there and an edited or
   * deleted entry after it is still detected. The removal is itself written to the log (`audit_log.pruned`, with
   * the actor, the cut-off and how many entries went) in the same transaction. This is the ONLY way entries leave
   * the log; the append-only protections still reject any other UPDATE or DELETE. Export what you must keep
   * (`search`) BEFORE pruning. Rejects (`audit_prune_invalid`) a cut-off in the future or an invalid date.
   *
   * **Performs no authorization of its own.** In Postgres the pruning function is revoked from `public`: grant it
   * only to the role that runs your retention job (see guides/hardening.md).
   */
  pruneBefore(input: PruneAuditLogInput): Promise<PruneAuditLogResult>;
  /**
   * Re-computes the hash chain over the whole log and reports the first entry that doesn't
   * match. Read-only, and linear in the size of the log: run it from a scheduled job, not per
   * request. Detects edited and deleted entries (not removal of the newest ones — see
   * `AuditIntegrityReport`).
   */
  verifyIntegrity(options?: AuditIntegrityOptions): Promise<AuditIntegrityReport>;
}

/** Validates a retention cut-off and returns it as a `Date`. Throws `AuditLogError` (`audit_prune_invalid`). */
export function assertPruneCutoff(before: Date, now: Date = new Date()): Date {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
    throw new AuditLogError("The retention cut-off must be a valid date.", "audit_prune_invalid");
  }
  if (before.getTime() > now.getTime()) {
    throw new AuditLogError("The retention cut-off cannot be in the future.", "audit_prune_invalid");
  }
  return before;
}
