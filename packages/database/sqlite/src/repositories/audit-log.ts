import type {
  AuditLogEntry,
  AuditLogRepository,
  AuditLogTarget,
  ListAuditLogOptions,
  ListRecentAuditLogOptions,
  RecordAuditLogInput,
} from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";

interface AuditLogRow {
  id: string;
  organization_id: string | null;
  actor_provider: string;
  actor_subject: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: string | null;
  created_at: string;
}

function toEntry(row: AuditLogRow): AuditLogEntry {
  const target: AuditLogTarget | undefined =
    row.target_type !== null && row.target_id !== null ? { type: row.target_type, id: row.target_id } : undefined;

  return {
    id: row.id,
    organizationId: row.organization_id ?? undefined,
    actor: { provider: row.actor_provider, subject: row.actor_subject },
    action: row.action,
    target,
    metadata: row.metadata !== null ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    createdAt: new Date(row.created_at),
  };
}

const SELECT_COLUMNS =
  "id, organization_id, actor_provider, actor_subject, action, target_type, target_id, metadata, created_at";

export function createAuditLogRepository(db: SqliteExecutor): AuditLogRepository {
  return {
    async record(input: RecordAuditLogInput) {
      const result = await db.query<AuditLogRow>(
        `insert into uniora_audit_logs
           (id, organization_id, actor_provider, actor_subject, action, target_type, target_id, metadata)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         returning ${SELECT_COLUMNS}`,
        [
          input.id,
          input.organizationId ?? null,
          input.actor.provider,
          input.actor.subject,
          input.action,
          input.target?.type ?? null,
          input.target?.id ?? null,
          input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
        ],
      );

      const row = result.rows[0];
      if (!row) throw new Error("uniora_audit_logs insert did not return a row");
      return toEntry(row);
    },

    async listByOrganization(organizationId: string, options?: ListAuditLogOptions) {
      // `limit -1` means "no limit" in SQLite. Same `(created_at, id)` total
      // order as `listRecent`, so a keyset `before` cursor pages one
      // organization's log with no gaps or repeats.
      const before = options?.before;
      const result = await db.query<AuditLogRow>(
        `select ${SELECT_COLUMNS}
         from uniora_audit_logs
         where organization_id = ?1
           and (?3 is null or (created_at, id) < (?3, ?4))
         order by created_at desc, id desc
         limit coalesce(?2, -1)`,
        [organizationId, options?.limit ?? null, before?.createdAt ?? null, before?.id ?? null],
      );
      return result.rows.map(toEntry);
    },

    async listRecent(options?: ListRecentAuditLogOptions) {
      const before = options?.before;
      const result = await db.query<AuditLogRow>(
        `select ${SELECT_COLUMNS}
         from uniora_audit_logs
         where ?1 is null or (created_at, id) < (?1, ?2)
         order by created_at desc, id desc
         limit coalesce(?3, -1)`,
        [before?.createdAt ?? null, before?.id ?? null, options?.limit ?? null],
      );
      return result.rows.map(toEntry);
    },
  };
}
