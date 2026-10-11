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
import type { SqliteExecutor } from "../executor.js";
import { jsonList, parseList } from "../json.js";
import { isUniqueViolation } from "../sqlite-errors.js";

interface EndpointRow {
  id: string;
  url: string;
  description: string | null;
  events: string;
  all_organizations: number;
  organization_ids: string;
  status: WebhookEndpointStatus;
  disabled_reason: string | null;
  disabled_at: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  created_by_provider: string;
  created_by_subject: string;
  updated_at: string;
  version: number;
}
/** Everything but the secrets: they are read by `signingSecrets` and nowhere else. */
const ENDPOINT_COLUMNS =
  "id, url, description, events, all_organizations, organization_ids, status, disabled_reason, disabled_at, consecutive_failures, last_success_at, last_failure_at, created_at, created_by_provider, created_by_subject, updated_at, version";

const date = (value: string | null): Date | undefined => (value === null ? undefined : new Date(value));
const toEndpoint = (row: EndpointRow): WebhookEndpoint => ({
  id: row.id,
  url: row.url,
  ...(row.description !== null ? { description: row.description } : {}),
  events: parseList(row.events).sort(),
  organizations: row.all_organizations === 1 ? "*" : parseList(row.organization_ids).sort(),
  status: row.status,
  ...(row.disabled_reason !== null ? { disabledReason: row.disabled_reason } : {}),
  ...(row.disabled_at !== null ? { disabledAt: new Date(row.disabled_at) } : {}),
  consecutiveFailures: row.consecutive_failures,
  ...(row.last_success_at !== null ? { lastSuccessAt: new Date(row.last_success_at) } : {}),
  ...(row.last_failure_at !== null ? { lastFailureAt: new Date(row.last_failure_at) } : {}),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  createdBy: { provider: row.created_by_provider, subject: row.created_by_subject },
  version: row.version,
});

export function createWebhookEndpointRepository(db: SqliteExecutor): WebhookEndpointRepository {
  const byId = async (id: string): Promise<EndpointRow | undefined> => (await db.query<EndpointRow>(`select ${ENDPOINT_COLUMNS} from uniora_webhook_endpoints where id = ?1`, [id])).rows[0];
  const need = async (id: string): Promise<EndpointRow> => {
    const row = await byId(id);
    if (!row) throw new WebhookError(`Webhook endpoint not found: ${id}`, "webhook_endpoint_not_found");
    return row;
  };

  return {
    async create(input: CreateWebhookEndpointInput) {
      const valid = assertValidCreateWebhookEndpoint(input);
      const now = new Date();
      return db.atomic(async () => {
        const { rows } = await db.query<{ n: number }>("select count(*) as n from uniora_webhook_endpoints");
        if (Number(rows[0]!.n) >= MAX_WEBHOOK_ENDPOINTS) throw new WebhookError(`At most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints.`, "webhook_endpoint_limit");
        try {
          const result = await db.query<EndpointRow>(
            `insert into uniora_webhook_endpoints
               (id, url, description, events, all_organizations, organization_ids, secret, created_at, created_by_provider, created_by_subject, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?8) returning ${ENDPOINT_COLUMNS}`,
            [
              input.id,
              valid.url,
              valid.description ?? null,
              jsonList(valid.events),
              valid.organizations === "*",
              jsonList(valid.organizations === "*" ? [] : valid.organizations),
              input.secret,
              now,
              input.createdBy.provider,
              input.createdBy.subject,
            ],
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
      return db.atomic(async () => {
        assertWebhookVersion(await need(id), input.expectedVersion);
        const result = await db.query<EndpointRow>(
          `update uniora_webhook_endpoints set
             url = coalesce(?2, url),
             description = case when ?3 then ?4 else description end,
             events = coalesce(?5, events),
             all_organizations = case when ?6 then ?7 else all_organizations end,
             organization_ids = case when ?6 then ?8 else organization_ids end,
             updated_at = ?9, version = version + 1
           where id = ?1 returning ${ENDPOINT_COLUMNS}`,
          [
            id,
            valid.url ?? null,
            valid.description !== undefined,
            valid.description ?? null,
            valid.events !== undefined ? jsonList(valid.events) : null,
            valid.organizations !== undefined,
            valid.organizations === "*",
            jsonList(valid.organizations === undefined || valid.organizations === "*" ? [] : valid.organizations),
            new Date(),
          ],
        );
        return toEndpoint(result.rows[0]!);
      });
    },

    async setStatus(id: string, status: WebhookEndpointStatus, input = {}) {
      assertWebhookId(id, "endpoint id");
      return db.atomic(async () => {
        assertWebhookVersion(await need(id), input.expectedVersion);
        const now = new Date();
        const result = await db.query<EndpointRow>(
          `update uniora_webhook_endpoints set
             status = ?2,
             disabled_reason = case when ?2 = 'disabled' then ?3 else null end,
             disabled_at = case when ?2 = 'disabled' then ?4 else null end,
             consecutive_failures = case when ?2 = 'enabled' then 0 else consecutive_failures end,
             updated_at = ?4, version = version + 1
           where id = ?1 returning ${ENDPOINT_COLUMNS}`,
          [id, status, normalizeWebhookReason(input.reason) ?? null, now],
        );
        return toEndpoint(result.rows[0]!);
      });
    },

    async rotateSecret(id, input) {
      assertWebhookId(id, "endpoint id");
      assertWebhookSecret(input.secret);
      return db.atomic(async () => {
        await need(id);
        const keep = input.previousValidUntil !== undefined;
        const result = await db.query<EndpointRow>(
          `update uniora_webhook_endpoints set
             previous_secret = case when ?3 then secret else null end,
             previous_valid_until = case when ?3 then ?4 else null end,
             secret = ?2, updated_at = ?5, version = version + 1
           where id = ?1 returning ${ENDPOINT_COLUMNS}`,
          [id, input.secret, keep, input.previousValidUntil ?? null, new Date()],
        );
        return toEndpoint(result.rows[0]!);
      });
    },

    async signingSecrets(id: string, now = new Date()) {
      const result = await db.query<{ secret: string; previous_secret: string | null; previous_valid_until: string | null }>(
        "select secret, previous_secret, previous_valid_until from uniora_webhook_endpoints where id = ?1",
        [id],
      );
      const row = result.rows[0];
      if (!row) return [];
      return row.previous_secret !== null && row.previous_valid_until !== null && new Date(row.previous_valid_until) > now ? [row.secret, row.previous_secret] : [row.secret];
    },

    async recordAttempt(id, input) {
      const at = input.at ?? new Date();
      const result = await db.query<EndpointRow>(
        `update uniora_webhook_endpoints set
           consecutive_failures = case when ?2 then 0 else consecutive_failures + 1 end,
           last_success_at = case when ?2 then ?3 else last_success_at end,
           last_failure_at = case when ?2 then last_failure_at else ?3 end,
           status = case when not ?2 and status = 'enabled' and ?4 is not null and consecutive_failures + 1 >= ?4 then 'disabled' else status end,
           disabled_reason = case when not ?2 and status = 'enabled' and ?4 is not null and consecutive_failures + 1 >= ?4 then 'too_many_failures' else disabled_reason end,
           disabled_at = case when not ?2 and status = 'enabled' and ?4 is not null and consecutive_failures + 1 >= ?4 then ?3 else disabled_at end,
           version = case when not ?2 and status = 'enabled' and ?4 is not null and consecutive_failures + 1 >= ?4 then version + 1 else version end,
           updated_at = ?3
         where id = ?1 returning ${ENDPOINT_COLUMNS}`,
        [id, input.success, at, input.disableAfter ?? null],
      );
      const row = result.rows[0];
      return row ? toEndpoint(row) : null;
    },

    async findById(id: string) {
      const row = await byId(id);
      return row ? toEndpoint(row) : null;
    },

    async search(options: SearchWebhookEndpointsOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const result = await db.query<EndpointRow>(
        `select ${ENDPOINT_COLUMNS} from uniora_webhook_endpoints where (?1 is null or status = ?1) and (?2 is null or id > ?2) order by id limit ?3`,
        [options.status ?? null, options.after ?? null, limit],
      );
      return result.rows.map(toEndpoint);
    },

    async count(options = {}) {
      const result = await db.query<{ n: number }>("select count(*) as n from uniora_webhook_endpoints where (?1 is null or status = ?1)", [options.status ?? null]);
      return Number(result.rows[0]!.n);
    },

    async delete(id: string) {
      return db.atomic(async () => {
        await db.query("delete from uniora_webhook_deliveries where endpoint_id = ?1", [id]);
        return (await db.query("delete from uniora_webhook_endpoints where id = ?1", [id])).rowCount > 0;
      });
    },
  };
}

interface DeliveryRow {
  seq: number;
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  organization_id: string | null;
  event_created_at: string;
  payload: string | null;
  status: WebhookDeliveryStatus;
  attempts: number;
  created_at: string;
  available_at: string;
  delivered_at: string | null;
  last_error: string | null;
  last_http_status: number | null;
  last_duration_ms: number | null;
}
const DELIVERY_COLUMNS =
  "seq, id, endpoint_id, event_id, event_type, organization_id, event_created_at, payload, status, attempts, created_at, available_at, delivered_at, last_error, last_http_status, last_duration_ms";
const toDelivery = (row: DeliveryRow): WebhookDelivery => ({
  id: row.id,
  seq: row.seq,
  endpointId: row.endpoint_id,
  eventId: row.event_id,
  eventType: row.event_type,
  ...(row.organization_id !== null ? { organizationId: row.organization_id } : {}),
  eventCreatedAt: new Date(row.event_created_at),
  ...(row.payload !== null ? { payload: JSON.parse(row.payload) as Record<string, unknown> } : {}),
  status: row.status,
  attempts: row.attempts,
  createdAt: new Date(row.created_at),
  availableAt: new Date(row.available_at),
  ...(row.delivered_at !== null ? { deliveredAt: date(row.delivered_at)! } : {}),
  ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  ...(row.last_http_status !== null ? { lastHttpStatus: row.last_http_status } : {}),
  ...(row.last_duration_ms !== null ? { lastDurationMs: row.last_duration_ms } : {}),
});

export function createWebhookDeliveryRepository(db: SqliteExecutor): WebhookDeliveryRepository {
  return {
    async enqueue(input: EnqueueWebhookDeliveryInput) {
      assertWebhookDelivery(input);
      const now = new Date();
      try {
        const result = await db.query(
          `insert into uniora_webhook_deliveries (id, endpoint_id, event_id, event_type, organization_id, event_created_at, payload, created_at, available_at)
           select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8 where exists (select 1 from uniora_webhook_endpoints where id = ?2)
           on conflict (id) do nothing`,
          [input.id, input.endpointId, input.eventId, input.eventType, input.organizationId ?? null, input.eventCreatedAt, input.payload === undefined ? null : JSON.stringify(input.payload), now],
        );
        return result.rowCount > 0;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    async claim(options?: ClaimWebhookDeliveriesOptions) {
      const { limit, leaseSeconds, now } = resolveWebhookClaim(options);
      const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
      return db.atomic(async () => {
        const result = await db.query<DeliveryRow>(
          `update uniora_webhook_deliveries
           set attempts = attempts + 1, locked_until = ?3
           where seq in (
             select d.seq from uniora_webhook_deliveries d
             join uniora_webhook_endpoints e on e.id = d.endpoint_id
             where d.status = 'pending' and d.available_at <= ?1 and (d.locked_until is null or d.locked_until <= ?1) and e.status = 'enabled'
             order by d.seq limit ?2
           )
           returning ${DELIVERY_COLUMNS}`,
          [now, limit, leaseUntil],
        );
        return result.rows.map(toDelivery).sort((a, b) => a.seq - b.seq);
      });
    },

    async complete(id: string, input: CompleteWebhookDeliveryInput) {
      const result = await db.query(
        `update uniora_webhook_deliveries set status = 'delivered', delivered_at = ?2, locked_until = null, last_error = null, last_http_status = ?3, last_duration_ms = ?4
         where id = ?1 and status = 'pending'`,
        [id, input.at ?? new Date(), input.httpStatus, input.durationMs],
      );
      return result.rowCount > 0;
    },

    async fail(id: string, input: FailWebhookDeliveryInput) {
      const result = await db.query<{ status: WebhookDeliveryStatus }>(
        `update uniora_webhook_deliveries
         set status = case when attempts >= ?4 then 'dead' else 'pending' end,
             available_at = ?3, locked_until = null, last_error = ?2, last_http_status = ?5, last_duration_ms = coalesce(?6, last_duration_ms)
         where id = ?1 and status = 'pending'
         returning status`,
        [id, input.error.slice(0, 600), input.retryAt, input.maxAttempts, input.httpStatus ?? null, input.durationMs ?? null],
      );
      return result.rows[0]?.status ?? null;
    },

    async requeue(id: string, now = new Date()) {
      const result = await db.query(
        `update uniora_webhook_deliveries set status = 'pending', attempts = 0, available_at = ?2, locked_until = null, last_error = null
         where id = ?1 and status = 'dead'`,
        [id, now],
      );
      return result.rowCount > 0;
    },

    async findById(id: string) {
      const row = (await db.query<DeliveryRow>(`select ${DELIVERY_COLUMNS} from uniora_webhook_deliveries where id = ?1`, [id])).rows[0];
      return row ? toDelivery(row) : null;
    },

    async search(options: SearchWebhookDeliveriesOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const result = await db.query<DeliveryRow>(
        `select ${DELIVERY_COLUMNS} from uniora_webhook_deliveries
         where (?1 is null or endpoint_id = ?1) and (?2 is null or status = ?2) and (?3 is null or event_type = ?3) and (?4 is null or seq < ?4)
         order by seq desc limit ?5`,
        [options.endpointId ?? null, options.status ?? null, options.eventType ?? null, options.beforeSeq ?? null, limit],
      );
      return result.rows.map(toDelivery);
    },

    async count(options = {}) {
      const result = await db.query<{ n: number }>(
        "select count(*) as n from uniora_webhook_deliveries where (?1 is null or endpoint_id = ?1) and (?2 is null or status = ?2)",
        [options.endpointId ?? null, options.status ?? null],
      );
      return Number(result.rows[0]!.n);
    },

    async pruneDelivered(before: Date) {
      return (await db.query("delete from uniora_webhook_deliveries where status = 'delivered' and delivered_at < ?1", [before])).rowCount;
    },
  };
}
