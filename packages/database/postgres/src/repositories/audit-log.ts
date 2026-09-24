import type {
  AuditLogEntry,
  AuditLogRepository,
  AuditLogTarget,
  ListAuditLogOptions,
  ListRecentAuditLogOptions,
  RecordAuditLogInput,
} from "@uniora/core";
import type { Queryable } from "../queryable.js";

interface AuditLogRow {
  id: string;
  organization_id: string;
  actor_provider: string;
  actor_subject: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

function toEntry(row: AuditLogRow): AuditLogEntry {
  const target: AuditLogTarget | undefined =
    row.target_type !== null && row.target_id !== null ? { type: row.target_type, id: row.target_id } : undefined;

  return {
    id: row.id,
    organizationId: row.organization_id,
    actor: { provider: row.actor_provider, subject: row.actor_subject },
    action: row.action,
    target,
    metadata: row.metadata ?? undefined,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS =
  "id, organization_id, actor_provider, actor_subject, action, target_type, target_id, metadata, created_at";

export function createAuditLogRepository(db: Queryable): AuditLogRepository {
  return {
    async record(input: RecordAuditLogInput) {
      const result = await db.query<AuditLogRow>(
        `insert into uniora.audit_logs
           (id, organization_id, actor_provider, actor_subject, action, target_type, target_id, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${SELECT_COLUMNS}`,
        [
          input.id,
          input.organizationId,
          input.actor.provider,
          input.actor.subject,
          input.action,
          input.target?.type ?? null,
          input.target?.id ?? null,
          input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
        ],
      );

      const row = result.rows[0];
      if (!row) throw new Error("uniora.audit_logs insert did not return a row");
      return toEntry(row);
    },

    async listByOrganization(organizationId: string, options?: ListAuditLogOptions) {
      // `limit $2` with a null parameter means "no limit" in Postgres
      // (LIMIT NULL === no LIMIT clause) — avoids building the query
      // string conditionally. Same `(created_at, id)` total order as
      // `listRecent`, so a keyset `before` cursor pages one organization's
      // log with no gaps or repeats (index: migration 0013).
      const before = options?.before;
      const result = await db.query<AuditLogRow>(
        `select ${SELECT_COLUMNS}
         from uniora.audit_logs
         where organization_id = $1
           and ($3::timestamptz is null or (created_at, id) < ($3, $4))
         order by created_at desc, id desc
         limit $2`,
        [organizationId, options?.limit ?? null, before?.createdAt ?? null, before?.id ?? null],
      );
      return result.rows.map(toEntry);
    },

    async listRecent(options?: ListRecentAuditLogOptions) {
      // Row comparison `(created_at, id) < ($1, $2)` is a single keyset
      // check the `audit_logs_created_at_id_idx` index (migration 0009)
      // can use directly — no `organization_id` predicate, unlike
      // `listByOrganization`, since this reads across every organization.
      const before = options?.before;
      const result = await db.query<AuditLogRow>(
        `select ${SELECT_COLUMNS}
         from uniora.audit_logs
         where $1::timestamptz is null or (created_at, id) < ($1, $2)
         order by created_at desc, id desc
         limit $3`,
        [before?.createdAt ?? null, before?.id ?? null, options?.limit ?? null],
      );
      return result.rows.map(toEntry);
    },
  };
}
