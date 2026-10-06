import type {
  AuditLogEntry,
  AuditLogRepository,
  AuditLogTarget,
  ListAuditLogOptions,
  AuditIntegrityOptions,
  AuditIntegrityReport,
  ListRecentAuditLogOptions,
  RecordAuditLogInput,
} from "@uniora/core";
import { applyAnchor, computeAuditEntryHash } from "@uniora/core";
import type { ChainedAuditFields } from "@uniora/core";
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
      // Read the previous hash and insert in ONE all-or-nothing step (`begin immediate` under the
      // hood), so concurrent writers — in this process or another — can't fork the chain.
      return db.atomic(async () => {
        const last = await db.query<{ hash: string }>(
          "select hash from uniora_audit_logs where hash is not null order by rowid desc limit 1",
        );
        const prevHash = last.rows[0]?.hash ?? null;
        const createdAt = new Date().toISOString();
        const metadataJson = input.metadata !== undefined ? JSON.stringify(input.metadata) : null;
        const hash = await computeAuditEntryHash(prevHash, {
          id: input.id,
          organizationId: input.organizationId ?? null,
          actorProvider: input.actor.provider,
          actorSubject: input.actor.subject,
          action: input.action,
          targetType: input.target?.type ?? null,
          targetId: input.target?.id ?? null,
          metadataJson,
          createdAt,
        });
        const result = await db.query<AuditLogRow>(
          `insert into uniora_audit_logs
             (id, organization_id, actor_provider, actor_subject, action, target_type, target_id, metadata, created_at, prev_hash, hash)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           returning ${SELECT_COLUMNS}`,
          [
            input.id,
            input.organizationId ?? null,
            input.actor.provider,
            input.actor.subject,
            input.action,
            input.target?.type ?? null,
            input.target?.id ?? null,
            metadataJson,
            createdAt,
            prevHash,
            hash,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error("uniora_audit_logs insert did not return a row");
        return toEntry(row);
      });
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

    async verifyIntegrity(options?: AuditIntegrityOptions): Promise<AuditIntegrityReport> {
      const report = await verifyChain();
      return applyAnchor(report, options?.anchor, async (position) => {
        const found = await db.query<{ hash: string | null }>("select hash from uniora_audit_logs where rowid = ?1", [position]);
        return found.rows[0]?.hash ?? null;
      });
    },
  };

  async function verifyChain(): Promise<AuditIntegrityReport> {
      interface ChainRow {
        rowid: number;
        id: string;
        organization_id: string | null;
        actor_provider: string;
        actor_subject: string;
        action: string;
        target_type: string | null;
        target_id: string | null;
        metadata: string | null;
        created_at: string;
        prev_hash: string | null;
        hash: string;
      }
      let prev: string | null = null;
      let checked = 0;
      let position = 0;
      let cursor = 0;
      for (;;) {
        const page = await db.query<ChainRow>(
          `select rowid, id, organization_id, actor_provider, actor_subject, action, target_type, target_id,
                  metadata, created_at, prev_hash, hash
           from uniora_audit_logs where hash is not null and rowid > ?1 order by rowid limit 500`,
          [cursor],
        );
        if (page.rows.length === 0) break;
        for (const row of page.rows) {
          if (row.prev_hash !== prev) return { ok: false, checked, broken: { id: row.id, reason: "chain_broken" } };
          const fields: ChainedAuditFields = {
            id: row.id,
            organizationId: row.organization_id,
            actorProvider: row.actor_provider,
            actorSubject: row.actor_subject,
            action: row.action,
            targetType: row.target_type,
            targetId: row.target_id,
            metadataJson: row.metadata,
            createdAt: row.created_at,
          };
          if (row.hash !== (await computeAuditEntryHash(prev, fields))) {
            return { ok: false, checked, broken: { id: row.id, reason: "content_mismatch" } };
          }
          prev = row.hash;
          checked += 1;
          position = row.rowid;
          cursor = row.rowid;
        }
      }
      return { ok: true, checked, head: prev === null ? undefined : { position, hash: prev } };
  }
}
