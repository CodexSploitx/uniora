import type { Identity } from "../identity/types.js";
import type { UnioraStorage } from "../storage/types.js";
import type { PruneAuditLogResult } from "./repository.js";
import { AuditLogError } from "./repository.js";

/** The shortest retention `applyAuditRetention` accepts, so a typo can't wipe the recent trail. */
export const MIN_AUDIT_RETENTION_DAYS = 30;

export interface AuditRetentionOptions {
  /** How long to keep entries, e.g. `{ years: 5 }` or `{ days: 365 }`. At least `MIN_AUDIT_RETENTION_DAYS` days. */
  keep: { years?: number; days?: number };
  /** Who runs the retention job; recorded in the log with the removal. */
  actor: Identity;
  /** Clock override for tests. */
  now?: Date;
}

export interface AuditRetentionResult extends PruneAuditLogResult {
  /** Entries older than this were eligible. */
  before: Date;
}

/**
 * The retention policy as one call: removes the audit entries older than `keep` (via `auditLogs.pruneBefore`, so the
 * hash chain keeps verifying from a checkpoint and the removal is itself audited). Run it from a scheduled job — it is
 * idempotent — and `search` + archive anything you must keep elsewhere BEFORE it runs.
 */
export async function applyAuditRetention(
  storage: Pick<UnioraStorage, "auditLogs">,
  options: AuditRetentionOptions,
): Promise<AuditRetentionResult> {
  const now = options.now ?? new Date();
  const years = options.keep.years ?? 0;
  const days = options.keep.days ?? 0;
  const totalDays = years * 365.25 + days;
  if (!Number.isFinite(totalDays) || totalDays < MIN_AUDIT_RETENTION_DAYS) {
    throw new AuditLogError(
      `Audit retention must keep at least ${MIN_AUDIT_RETENTION_DAYS} days.`,
      "audit_prune_invalid",
    );
  }
  const before = new Date(now.getTime() - totalDays * 86_400_000);
  const result = await storage.auditLogs.pruneBefore({ before, actor: options.actor });
  return { ...result, before };
}
