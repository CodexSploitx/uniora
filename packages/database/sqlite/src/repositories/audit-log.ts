import type {
  AuditLogEntry,
  AuditLogRepository,
  AuditLogTarget,
  ListAuditLogOptions,
  AuditIntegrityOptions,
  AuditIntegrityReport,
  ListRecentAuditLogOptions,
  PruneAuditLogInput,
  PruneAuditLogResult,
  RecordAuditLogInput,
  SearchAuditLogOptions,
} from "@uniora/core";
import { randomUUID } from "node:crypto";
import { applyAnchor, assertAuditInput, assertPruneCutoff, computeAuditEntryHash } from "@uniora/core";
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
  const repository: AuditLogRepository = {
    async record(input: RecordAuditLogInput) {
      assertAuditInput(input);
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

    async search(options?: SearchAuditLogOptions) {
      const actions = options?.action === undefined ? null : JSON.stringify(Array.isArray(options.action) ? options.action : [options.action]);
      const before = options?.before;
      const result = await db.query<AuditLogRow>(
        `select ${SELECT_COLUMNS}
         from uniora_audit_logs
         where (?1 is null or organization_id = ?1)
           and (?2 is null or action in (select value from json_each(?2)))
           and (?3 is null or instr(action, ?3) = 1)
           and (?4 is null or (actor_provider = ?4 and actor_subject = ?5))
           and (?6 is null or (target_type = ?6 and (?7 is null or target_id = ?7)))
           and (?8 is null or created_at >= ?8)
           and (?9 is null or created_at < ?9)
           and (?10 is null or (created_at, id) < (?10, ?11))
         order by created_at desc, id desc
         limit coalesce(?12, -1)`,
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

    async pruneBefore(input: PruneAuditLogInput): Promise<PruneAuditLogResult> {
      const before = assertPruneCutoff(input.before);
      assertAuditInput({ actor: input.actor, action: "audit_log.pruned" });
      return db.atomic(async () => {
        const head = await db.query<{ rowid: number }>("select max(rowid) as rowid from uniora_audit_logs");
        const headRowid = head.rows[0]?.rowid ?? null;
        if (headRowid === null) return { removed: 0 };
        // A contiguous prefix: everything before the first entry that is not old enough; never the newest entry.
        const kept = await db.query<{ rowid: number | null }>(
          "select min(rowid) as rowid from uniora_audit_logs where created_at >= ?1",
          [before.toISOString()],
        );
        const limit = Math.min(kept.rows[0]?.rowid ?? headRowid, headRowid);
        const through = await db.query<{ rowid: number; hash: string }>(
          "select rowid, hash from uniora_audit_logs where rowid < ?1 order by rowid desc limit 1",
          [limit],
        );
        const last = through.rows[0];
        if (!last) return { removed: 0 };

        // The only DELETE the log ever allows. Triggers are transactional in SQLite: a failure below puts it back.
        await db.query("drop trigger if exists uniora_audit_logs_no_delete");
        const deleted = await db.query("delete from uniora_audit_logs where rowid < ?1", [limit]);
        await db.query(
          `create trigger if not exists uniora_audit_logs_no_delete before delete on uniora_audit_logs
           begin
             select raise(abort, 'uniora_audit_logs is append-only: DELETE is not allowed');
           end`,
        );
        const removed = deleted.rowCount;
        await db.query(
          `insert into uniora_audit_log_checkpoints (through_seq, through_hash, removed, cutoff, created_at)
           values (?1, ?2, ?3, ?4, ?5)`,
          [last.rowid, last.hash, removed, before.toISOString(), new Date().toISOString()],
        );
        await repository.record({
          id: `audit-pruned:${randomUUID()}`,
          actor: input.actor,
          action: "audit_log.pruned",
          metadata: { before: before.toISOString(), removed, throughPosition: last.rowid },
        });
        return { removed, through: { position: last.rowid, hash: last.hash } };
      });
    },

    async verifyIntegrity(options?: AuditIntegrityOptions): Promise<AuditIntegrityReport> {
      const report = await verifyChain();
      return applyAnchor(report, options?.anchor, async (position) => {
        const found = await db.query<{ hash: string | null }>("select hash from uniora_audit_logs where rowid = ?1", [position]);
        return found.rows[0]?.hash ?? null;
      });
    },
  };
  return repository;

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
      const pruned = await prunedSummary();
      let prev: string | null = pruned.pruned?.through.hash ?? null;
      let checked = 0;
      let position = pruned.pruned?.through.position ?? 0;
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
          if (row.prev_hash !== prev) return { ok: false, checked, broken: { id: row.id, reason: "chain_broken" }, ...pruned };
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
            return { ok: false, checked, broken: { id: row.id, reason: "content_mismatch" }, ...pruned };
          }
          prev = row.hash;
          checked += 1;
          position = row.rowid;
          cursor = row.rowid;
        }
      }
      return { ok: true, checked, head: prev === null ? undefined : { position, hash: prev }, ...pruned };
  }

  /** The newest retention checkpoint and the total removed so far, or nothing when the log was never pruned. */
  async function prunedSummary(): Promise<{ pruned?: AuditIntegrityReport["pruned"] }> {
    const result = await db.query<{ through_seq: number; through_hash: string; removed: number }>(
      `select through_seq, through_hash, (select sum(removed) from uniora_audit_log_checkpoints) as removed
       from uniora_audit_log_checkpoints order by through_seq desc limit 1`,
    );
    const row = result.rows[0];
    if (!row) return {};
    return { pruned: { through: { position: row.through_seq, hash: row.through_hash }, removed: row.removed } };
  }
}
