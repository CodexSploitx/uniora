import type {
  ClaimWebhookDeliveriesOptions,
  CompleteWebhookDeliveryInput,
  CreateWebhookEndpointInput,
  EnqueueWebhookDeliveryInput,
  FailWebhookDeliveryInput,
  SearchWebhookDeliveriesOptions,
  SearchWebhookEndpointsOptions,
  UpdateWebhookEndpointInput,
  WebhookDelivery,
  WebhookDeliveryRepository,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointRepository,
  WebhookEndpointStatus,
} from "@uniora/core";
import {
  MAX_WEBHOOK_ENDPOINTS,
  WebhookError,
  assertValidCreateWebhookEndpoint,
  assertValidUpdateWebhookEndpoint,
  assertWebhookDelivery,
  assertWebhookId,
  assertWebhookSecret,
  assertWebhookVersion,
  normalizeWebhookReason,
  resolveWebhookClaim,
} from "@uniora/core";
import type { Pool } from "pg";
import type { Queryable } from "../queryable.js";
import { isUniqueViolation } from "../pg-errors.js";

/**
 * Runs `work` on a single connection inside a transaction. Inside `storage.transaction()` the repositories are already bound to the
 * caller's client and join it; at the top level (a pool) each write opens its own short transaction, so the row lock it takes is held
 * for the whole check-then-write.
 */
function transactional(db: Queryable, pool: Pool | undefined) {
  return async function run<T>(work: (q: Queryable) => Promise<T>): Promise<T> {
    if (!pool) return work(db);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}

interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  all_organizations: boolean;
  organization_ids: string[];
  status: WebhookEndpointStatus;
  disabled_reason: string | null;
  disabled_at: Date | null;
  consecutive_failures: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  created_at: Date;
  created_by_provider: string;
  created_by_subject: string;
  updated_at: Date;
  version: number;
}
/** Everything but the secrets: they are read by `signingSecrets` and nowhere else. */
const ENDPOINT_COLUMNS =
  "id, url, description, events, all_organizations, organization_ids, status, disabled_reason, disabled_at, consecutive_failures, last_success_at, last_failure_at, created_at, created_by_provider, created_by_subject, updated_at, version";

const toEndpoint = (row: EndpointRow): WebhookEndpoint => ({
  id: row.id,
  url: row.url,
  ...(row.description !== null ? { description: row.description } : {}),
  events: [...row.events].sort(),
  organizations: row.all_organizations ? "*" : [...row.organization_ids].sort(),
  status: row.status,
  ...(row.disabled_reason !== null ? { disabledReason: row.disabled_reason } : {}),
  ...(row.disabled_at !== null ? { disabledAt: row.disabled_at } : {}),
  consecutiveFailures: row.consecutive_failures,
  ...(row.last_success_at !== null ? { lastSuccessAt: row.last_success_at } : {}),
  ...(row.last_failure_at !== null ? { lastFailureAt: row.last_failure_at } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdBy: { provider: row.created_by_provider, subject: row.created_by_subject },
  version: row.version,
});

export function createWebhookEndpointRepository(db: Queryable, pool?: Pool): WebhookEndpointRepository {
  /** Reads the row under a lock, inside a transaction (the caller's, or a short one of its own when bound to the pool). */
  const locked = <T>(id: string, work: (q: Queryable, row: EndpointRow) => Promise<T>): Promise<T> =>
    transactional(db, pool)(async (q) => {
      const row = (await q.query<EndpointRow>(`select ${ENDPOINT_COLUMNS} from uniora_webhooks.endpoints where id = $1 for update`, [id])).rows[0];
      if (!row) throw new WebhookError(`Webhook endpoint not found: ${id}`, "webhook_endpoint_not_found");
      return work(q, row);
    });

  return {
    async create(input: CreateWebhookEndpointInput) {
      const valid = assertValidCreateWebhookEndpoint(input);
      return transactional(db, pool)(async (q) => {
        // Serializes concurrent creators, so the cap holds however many race for the last slot.
        await q.query("select pg_advisory_xact_lock(hashtext('uniora_webhooks.endpoints'))");
        const { rows } = await q.query<{ n: string }>("select count(*)::text as n from uniora_webhooks.endpoints");
        if (Number(rows[0]!.n) >= MAX_WEBHOOK_ENDPOINTS) throw new WebhookError(`At most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints.`, "webhook_endpoint_limit");
        try {
          const result = await q.query<EndpointRow>(
            `insert into uniora_webhooks.endpoints
               (id, url, description, events, all_organizations, organization_ids, secret, created_by_provider, created_by_subject)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${ENDPOINT_COLUMNS}`,
            [input.id, valid.url, valid.description ?? null, valid.events, valid.organizations === "*", valid.organizations === "*" ? [] : valid.organizations, input.secret, input.createdBy.provider, input.createdBy.subject],
          );
          return toEndpoint(result.rows[0]!);
        } catch (error) {
          if (isUniqueViolation(error)) throw new WebhookError(`A webhook endpoint with id "${input.id}" already exists.`);
          throw error;
        }
      });
    },

    async update(id: string, input: UpdateWebhookEndpointInput) {
      const valid = assertValidUpdateWebhookEndpoint(input);
      assertWebhookId(id, "endpoint id");
      return locked(id, async (q, current) => {
        assertWebhookVersion(current, input.expectedVersion);
        const result = await q.query<EndpointRow>(
          `update uniora_webhooks.endpoints set
             url = coalesce($2, url),
             description = case when $3 then $4 else description end,
             events = coalesce($5, events),
             all_organizations = case when $6 then $7 else all_organizations end,
             organization_ids = case when $6 then $8 else organization_ids end,
             updated_at = date_trunc('milliseconds', now()), version = version + 1
           where id = $1 returning ${ENDPOINT_COLUMNS}`,
          [
            id,
            valid.url ?? null,
            valid.description !== undefined,
            valid.description ?? null,
            valid.events ?? null,
            valid.organizations !== undefined,
            valid.organizations === "*",
            valid.organizations === undefined || valid.organizations === "*" ? [] : valid.organizations,
          ],
        );
        return toEndpoint(result.rows[0]!);
      });
    },

    async setStatus(id: string, status: WebhookEndpointStatus, input = {}) {
      assertWebhookId(id, "endpoint id");
      return locked(id, async (q, current) => {
        assertWebhookVersion(current, input.expectedVersion);
        const result = await q.query<EndpointRow>(
          `update uniora_webhooks.endpoints set
             status = $2,
             disabled_reason = case when $2 = 'disabled' then $3 else null end,
             disabled_at = case when $2 = 'disabled' then date_trunc('milliseconds', now()) else null end,
             consecutive_failures = case when $2 = 'enabled' then 0 else consecutive_failures end,
             updated_at = date_trunc('milliseconds', now()), version = version + 1
           where id = $1 returning ${ENDPOINT_COLUMNS}`,
          [id, status, normalizeWebhookReason(input.reason) ?? null],
        );
        return toEndpoint(result.rows[0]!);
      });
    },

    async rotateSecret(id, input) {
      assertWebhookId(id, "endpoint id");
      assertWebhookSecret(input.secret);
      return locked(id, async (q) => {
        const keep = input.previousValidUntil !== undefined;
        const result = await q.query<EndpointRow>(
          `update uniora_webhooks.endpoints set
             previous_secret = case when $3 then secret else null end,
             previous_valid_until = case when $3 then $4::timestamptz else null end,
             secret = $2, updated_at = date_trunc('milliseconds', now()), version = version + 1
           where id = $1 returning ${ENDPOINT_COLUMNS}`,
          [id, input.secret, keep, input.previousValidUntil ?? null],
        );
        return toEndpoint(result.rows[0]!);
      });
    },

    async signingSecrets(id: string, now = new Date()) {
      const result = await db.query<{ secret: string; previous_secret: string | null; previous_valid_until: Date | null }>(
        "select secret, previous_secret, previous_valid_until from uniora_webhooks.endpoints where id = $1",
        [id],
      );
      const row = result.rows[0];
      if (!row) return [];
      return row.previous_secret !== null && row.previous_valid_until !== null && row.previous_valid_until > now ? [row.secret, row.previous_secret] : [row.secret];
    },

    async recordAttempt(id, input) {
      const at = input.at ?? new Date();
      // One statement, so concurrent attempts count exactly.
      const result = await db.query<EndpointRow>(
        `update uniora_webhooks.endpoints set
           consecutive_failures = case when $2 then 0 else consecutive_failures + 1 end,
           last_success_at = case when $2 then $3::timestamptz else last_success_at end,
           last_failure_at = case when $2 then last_failure_at else $3::timestamptz end,
           status = case when not $2 and status = 'enabled' and $4::int is not null and consecutive_failures + 1 >= $4::int then 'disabled' else status end,
           disabled_reason = case when not $2 and status = 'enabled' and $4::int is not null and consecutive_failures + 1 >= $4::int then 'too_many_failures' else disabled_reason end,
           disabled_at = case when not $2 and status = 'enabled' and $4::int is not null and consecutive_failures + 1 >= $4::int then $3::timestamptz else disabled_at end,
           version = case when not $2 and status = 'enabled' and $4::int is not null and consecutive_failures + 1 >= $4::int then version + 1 else version end,
           updated_at = $3::timestamptz
         where id = $1 returning ${ENDPOINT_COLUMNS}`,
        [id, input.success, at, input.disableAfter ?? null],
      );
      const row = result.rows[0];
      return row ? toEndpoint(row) : null;
    },

    async findById(id: string) {
      const row = (await db.query<EndpointRow>(`select ${ENDPOINT_COLUMNS} from uniora_webhooks.endpoints where id = $1`, [id])).rows[0];
      return row ? toEndpoint(row) : null;
    },

    async search(options: SearchWebhookEndpointsOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const result = await db.query<EndpointRow>(
        `select ${ENDPOINT_COLUMNS} from uniora_webhooks.endpoints where ($1::text is null or status = $1) and ($2::text is null or id > $2) order by id limit $3`,
        [options.status ?? null, options.after ?? null, limit],
      );
      return result.rows.map(toEndpoint);
    },

    async count(options = {}) {
      const result = await db.query<{ n: string }>("select count(*)::text as n from uniora_webhooks.endpoints where ($1::text is null or status = $1)", [options.status ?? null]);
      return Number(result.rows[0]!.n);
    },

    async delete(id: string) {
      // Deliveries go with it (`on delete cascade`).
      return ((await db.query("delete from uniora_webhooks.endpoints where id = $1", [id])).rowCount ?? 0) > 0;
    },
  };
}

interface DeliveryRow {
  seq: string;
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  organization_id: string | null;
  event_created_at: Date;
  payload: Record<string, unknown> | null;
  status: WebhookDeliveryStatus;
  attempts: number;
  created_at: Date;
  available_at: Date;
  delivered_at: Date | null;
  last_error: string | null;
  last_http_status: number | null;
  last_duration_ms: number | null;
}
const DELIVERY_COLUMNS =
  "seq, id, endpoint_id, event_id, event_type, organization_id, event_created_at, payload, status, attempts, created_at, available_at, delivered_at, last_error, last_http_status, last_duration_ms";
const toDelivery = (row: DeliveryRow): WebhookDelivery => ({
  id: row.id,
  seq: Number(row.seq),
  endpointId: row.endpoint_id,
  eventId: row.event_id,
  eventType: row.event_type,
  ...(row.organization_id !== null ? { organizationId: row.organization_id } : {}),
  eventCreatedAt: row.event_created_at,
  ...(row.payload !== null ? { payload: row.payload } : {}),
  status: row.status,
  attempts: row.attempts,
  createdAt: row.created_at,
  availableAt: row.available_at,
  ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
  ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  ...(row.last_http_status !== null ? { lastHttpStatus: row.last_http_status } : {}),
  ...(row.last_duration_ms !== null ? { lastDurationMs: row.last_duration_ms } : {}),
});

export function createWebhookDeliveryRepository(db: Queryable): WebhookDeliveryRepository {
  return {
    async enqueue(input: EnqueueWebhookDeliveryInput) {
      assertWebhookDelivery(input);
      const result = await db.query(
        `insert into uniora_webhooks.deliveries (id, endpoint_id, event_id, event_type, organization_id, event_created_at, payload, available_at)
         select $1, $2, $3, $4, $5, $6, $7::jsonb, date_trunc('milliseconds', now()) where exists (select 1 from uniora_webhooks.endpoints where id = $2)
         on conflict (id) do nothing`,
        [input.id, input.endpointId, input.eventId, input.eventType, input.organizationId ?? null, input.eventCreatedAt, input.payload === undefined ? null : JSON.stringify(input.payload)],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async claim(options?: ClaimWebhookDeliveriesOptions) {
      const { limit, leaseSeconds, now } = resolveWebhookClaim(options);
      const result = await db.query<DeliveryRow>(
        `with picked as (
           select d.seq from uniora_webhooks.deliveries d
           join uniora_webhooks.endpoints e on e.id = d.endpoint_id
           where d.status = 'pending' and d.available_at <= $1 and (d.locked_until is null or d.locked_until <= $1) and e.status = 'enabled'
           order by d.seq limit $2
           for update of d skip locked
         )
         update uniora_webhooks.deliveries d
         set attempts = d.attempts + 1, locked_until = $1::timestamptz + make_interval(secs => $3)
         from picked where d.seq = picked.seq
         returning ${DELIVERY_COLUMNS.split(", ").map((column) => `d.${column}`).join(", ")}`,
        [now, limit, leaseSeconds],
      );
      return result.rows.map(toDelivery).sort((a, b) => a.seq - b.seq);
    },

    async complete(id: string, input: CompleteWebhookDeliveryInput) {
      const result = await db.query(
        `update uniora_webhooks.deliveries set status = 'delivered', delivered_at = $2, locked_until = null, last_error = null, last_http_status = $3, last_duration_ms = $4
         where id = $1 and status = 'pending'`,
        [id, input.at ?? new Date(), input.httpStatus, input.durationMs],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async fail(id: string, input: FailWebhookDeliveryInput) {
      const result = await db.query<{ status: WebhookDeliveryStatus }>(
        `update uniora_webhooks.deliveries
         set status = case when attempts >= $4 then 'dead' else 'pending' end,
             available_at = $3, locked_until = null, last_error = $2, last_http_status = $5, last_duration_ms = coalesce($6, last_duration_ms)
         where id = $1 and status = 'pending'
         returning status`,
        [id, input.error.slice(0, 600), input.retryAt, input.maxAttempts, input.httpStatus ?? null, input.durationMs ?? null],
      );
      return result.rows[0]?.status ?? null;
    },

    async requeue(id: string, now = new Date()) {
      const result = await db.query(
        `update uniora_webhooks.deliveries set status = 'pending', attempts = 0, available_at = $2, locked_until = null, last_error = null
         where id = $1 and status = 'dead'`,
        [id, now],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async findById(id: string) {
      const row = (await db.query<DeliveryRow>(`select ${DELIVERY_COLUMNS} from uniora_webhooks.deliveries where id = $1`, [id])).rows[0];
      return row ? toDelivery(row) : null;
    },

    async search(options: SearchWebhookDeliveriesOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const result = await db.query<DeliveryRow>(
        `select ${DELIVERY_COLUMNS} from uniora_webhooks.deliveries
         where ($1::text is null or endpoint_id = $1) and ($2::text is null or status = $2) and ($3::text is null or event_type = $3) and ($4::bigint is null or seq < $4)
         order by seq desc limit $5`,
        [options.endpointId ?? null, options.status ?? null, options.eventType ?? null, options.beforeSeq ?? null, limit],
      );
      return result.rows.map(toDelivery);
    },

    async count(options = {}) {
      const result = await db.query<{ n: string }>(
        "select count(*)::text as n from uniora_webhooks.deliveries where ($1::text is null or endpoint_id = $1) and ($2::text is null or status = $2)",
        [options.endpointId ?? null, options.status ?? null],
      );
      return Number(result.rows[0]!.n);
    },

    async pruneDelivered(before: Date) {
      return (await db.query("delete from uniora_webhooks.deliveries where status = 'delivered' and delivered_at < $1", [before])).rowCount ?? 0;
    },
  };
}
