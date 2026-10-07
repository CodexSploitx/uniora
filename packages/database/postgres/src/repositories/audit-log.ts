import type {
  AuditLogEntry,
  AuditLogRepository,
  AuditLogTarget,
  ListAuditLogOptions,
  AuditIntegrityOptions,
  AuditIntegrityReport,
  ListRecentAuditLogOptions,
  RecordAuditLogInput,
  SearchAuditLogOptions,
} from "@uniora/core";
import { applyAnchor, assertAuditInput } from "@uniora/core";
import type { Queryable } from "../queryable.js";

interface AuditLogRow {
  id: string;
  organization_id: string | null;
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
    organizationId: row.organization_id ?? undefined,
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
      assertAuditInput(input);
      const result = await db.query<AuditLogRow>(
        `insert into uniora.audit_logs
           (id, organization_id, actor_provider, actor_subject, action, target_type, target_id, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
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
      if (!row) throw new Error("uniora.audit_logs insert did not return a row");
      return toEntry(row);
    },

    async search(options?: SearchAuditLogOptions) {
      const actions = options?.action === undefined ? null : Array.isArray(options.action) ? options.action : [options.action];
      const before = options?.before;
      const result = await db.query<AuditLogRow>(
        `select ${SELECT_COLUMNS}
         from uniora.audit_logs
         where ($1::text is null or organization_id = $1)
           and ($2::text[] is null or action = any($2))
           and ($3::text is null or starts_with(action, $3))
           and ($4::text is null or (actor_provider = $4 and actor_subject = $5))
           and ($6::text is null or (target_type = $6 and ($7::text is null or target_id = $7)))
           and ($8::timestamptz is null or created_at >= $8)
           and ($9::timestamptz is null or created_at < $9)
           and ($10::timestamptz is null or (created_at, id) < ($10, $11))
         order by created_at desc, id desc
         limit $12`,
        [
          options?.organizationId ?? null,
          actions,
          options?.actionPrefix ?? null,
          options?.actor?.provider ?? null,
          options?.actor?.subject ?? null,
          options?.target?.type ?? null,
          options?.target?.id ?? null,
          options?.since ?? null,
          options?.until ?? null,
          before?.createdAt ?? null,
          before?.id ?? null,
          options?.limit ?? null,
        ],
      );
      return result.rows.map(toEntry);
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

    async verifyIntegrity(options?: AuditIntegrityOptions): Promise<AuditIntegrityReport> {
      const report = await verifyChain();
      return applyAnchor(report, options?.anchor, async (position) => {
        const found = await db.query<{ hash: string }>("select hash from uniora.audit_logs where seq = $1", [position]);
        return found.rows[0]?.hash ?? null;
      });
    },
  };

  async function verifyChain(): Promise<AuditIntegrityReport> {
      const result = await db.query<{
        checked: string;
        head_seq: string | null;
        head_hash: string | null;
        broken_id: string | null;
        broken_reason: "content_mismatch" | "chain_broken" | null;
      }>("select checked::text, head_seq::text, head_hash, broken_id, broken_reason from uniora.verify_audit_chain()");
      const row = result.rows[0];
      if (!row) throw new Error("uniora.verify_audit_chain() returned no row");
      const checked = Number(row.checked);
      if (row.broken_id !== null && row.broken_reason !== null) {
        return { ok: false, checked, broken: { id: row.broken_id, reason: row.broken_reason } };
      }
      return {
        ok: true,
        checked,
        head: row.head_hash !== null && row.head_seq !== null ? { position: Number(row.head_seq), hash: row.head_hash } : undefined,
      };
  }
}
