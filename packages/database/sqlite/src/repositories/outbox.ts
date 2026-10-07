import type {
  ClaimOutboxOptions,
  EnqueueOutboxInput,
  FailOutboxInput,
  OutboxEvent,
  OutboxRepository,
  OutboxStatus,
  SearchOutboxOptions,
} from "@uniora/core";
import { OutboxError, assertValidOutboxEvent, resolveClaimOptions } from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { jsonList } from "../json.js";
import { isUniqueViolation } from "../sqlite-errors.js";

interface OutboxRow {
  seq: number;
  id: string;
  organization_id: string | null;
  type: string;
  payload: string | null;
  status: OutboxStatus;
  attempts: number;
  created_at: string;
  available_at: string;
  delivered_at: string | null;
  last_error: string | null;
}

const COLUMNS = "seq, id, organization_id, type, payload, status, attempts, created_at, available_at, delivered_at, last_error";

function toEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    seq: row.seq,
    organizationId: row.organization_id ?? undefined,
    type: row.type,
    payload: row.payload === null ? undefined : (JSON.parse(row.payload) as Record<string, unknown>),
    status: row.status,
    attempts: row.attempts,
    createdAt: new Date(row.created_at),
    availableAt: new Date(row.available_at),
    deliveredAt: row.delivered_at === null ? undefined : new Date(row.delivered_at),
    lastError: row.last_error ?? undefined,
  };
}

export function createOutboxRepository(db: SqliteExecutor): OutboxRepository {
  return {
    async enqueue(input: EnqueueOutboxInput) {
      assertValidOutboxEvent(input);
      const now = new Date();
      try {
        const result = await db.query<OutboxRow>(
          `insert into uniora_outbox (id, organization_id, type, payload, created_at, available_at)
           values (?1, ?2, ?3, ?4, ?5, ?5) returning ${COLUMNS}`,
          [input.id, input.organizationId ?? null, input.type, input.payload === undefined ? null : JSON.stringify(input.payload), now],
        );
        return toEvent(result.rows[0]!);
      } catch (error) {
        if (isUniqueViolation(error)) throw new OutboxError(`An event with id "${input.id}" already exists.`, "outbox_event_exists");
        throw error;
      }
    },

    async claim(options?: ClaimOutboxOptions) {
      const { limit, leaseSeconds, now } = resolveClaimOptions(options);
      const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
      // Select and lease in ONE `begin immediate` transaction: two processes can't both take the same event.
      return db.atomic(async () => {
        const result = await db.query<OutboxRow>(
          `update uniora_outbox
           set attempts = attempts + 1, locked_until = ?3
           where seq in (
             select seq from uniora_outbox
             where status = 'pending'
               and available_at <= ?1
               and (locked_until is null or locked_until <= ?1)
               and (?4 is null or type = ?4)
               and (?5 is null or organization_id = ?5)
             order by seq
             limit ?2
           )
           returning ${COLUMNS}`,
          [now, limit, leaseUntil, options?.type ?? null, options?.organizationId ?? null],
        );
        return result.rows.map(toEvent).sort((a, b) => a.seq - b.seq);
      });
    },

    async complete(ids: string[], now = new Date()) {
      if (ids.length === 0) return 0;
      const result = await db.query(
        `update uniora_outbox set status = 'delivered', delivered_at = ?2, locked_until = null
         where id in (select value from json_each(?1)) and status = 'pending'`,
        [jsonList([...new Set(ids)]), now],
      );
      return result.rowCount;
    },

    async fail(id: string, input: FailOutboxInput) {
      const result = await db.query<{ status: OutboxStatus }>(
        `update uniora_outbox
         set status = case when attempts >= ?4 then 'dead' else 'pending' end,
             available_at = ?3, locked_until = null, last_error = ?2
         where id = ?1 and status = 'pending'
         returning status`,
        [id, input.error, input.retryAt, input.maxAttempts],
      );
      return result.rows[0]?.status ?? null;
    },

    async requeue(id: string, now = new Date()) {
      const result = await db.query(
        `update uniora_outbox set status = 'pending', attempts = 0, available_at = ?2, locked_until = null, last_error = null
         where id = ?1 and status = 'dead'`,
        [id, now],
      );
      return result.rowCount > 0;
    },

    async findById(id: string) {
      const result = await db.query<OutboxRow>(`select ${COLUMNS} from uniora_outbox where id = ?1`, [id]);
      const row = result.rows[0];
      return row ? toEvent(row) : null;
    },

    async search(options: SearchOutboxOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const result = await db.query<OutboxRow>(
        `select ${COLUMNS} from uniora_outbox
         where (?1 is null or status = ?1) and (?2 is null or organization_id = ?2) and (?3 is null or type = ?3) and seq > ?4
         order by seq limit ?5`,
        [options.status ?? null, options.organizationId ?? null, options.type ?? null, options.afterSeq ?? 0, limit],
      );
      return result.rows.map(toEvent);
    },

    async count(options = {}) {
      const result = await db.query<{ n: number }>(
        `select count(*) as n from uniora_outbox
         where (?1 is null or status = ?1) and (?2 is null or organization_id = ?2) and (?3 is null or type = ?3)`,
        [options.status ?? null, options.organizationId ?? null, options.type ?? null],
      );
      return Number(result.rows[0]!.n);
    },

    async pruneDelivered(before: Date) {
      const result = await db.query(`delete from uniora_outbox where status = 'delivered' and delivered_at < ?1`, [before]);
      return result.rowCount;
    },
  };
}
