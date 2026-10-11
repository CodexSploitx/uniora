import { createMemoryStorage } from "../storage/memory.js";
import type { AuditLogRepository } from "../audit-log/repository.js";
import { WebhookError } from "./errors.js";
import {
  MAX_WEBHOOK_ENDPOINTS,
  assertValidCreateWebhookEndpoint,
  assertValidUpdateWebhookEndpoint,
  assertWebhookDelivery,
  assertWebhookSecret,
  assertWebhookVersion,
  normalizeWebhookReason,
  resolveWebhookClaim,
} from "./repository.js";
import type { SearchWebhookDeliveriesOptions, WebhookDeliveryRepository, WebhookEndpointRepository, WebhookStorage, WebhookTransaction } from "./repository.js";
import type { WebhookDelivery, WebhookEndpoint } from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);
type Writable<T> = { -readonly [K in keyof T]: T[K] };
interface StoredEndpoint extends Writable<WebhookEndpoint> {
  secret: string;
  previousSecret?: string;
  previousValidUntil?: Date;
}
interface StoredDelivery extends Writable<WebhookDelivery> {
  leasedUntil?: Date;
}
const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const publicEndpoint = ({ secret: _secret, previousSecret: _previous, previousValidUntil: _until, ...endpoint }: StoredEndpoint): WebhookEndpoint => clone(endpoint);
const publicDelivery = ({ leasedUntil: _leased, ...delivery }: StoredDelivery): WebhookDelivery => clone(delivery);

export interface MemoryWebhookStorageOptions {
  /** Where audit entries go. Pass `storage.auditLogs` of the `UnioraStorage` you use so both share one trail. */
  auditLogs?: AuditLogRepository;
}

/** In-memory `WebhookStorage` for tests and prototypes. It enforces the same rules as the database backends. */
export function createMemoryWebhookStorage(options: MemoryWebhookStorageOptions = {}): WebhookStorage {
  const auditLogs = options.auditLogs ?? createMemoryStorage().auditLogs;
  const endpointRows = new Map<string, StoredEndpoint>();
  const deliveryRows = new Map<string, StoredDelivery>();
  let seq = 0;

  const get = (id: string): StoredEndpoint => {
    const row = endpointRows.get(id);
    if (!row) throw new WebhookError(`Webhook endpoint not found: ${id}`, "webhook_endpoint_not_found");
    return row;
  };

  const endpoints: WebhookEndpointRepository = {
    async create(input) {
      const valid = assertValidCreateWebhookEndpoint(input);
      if (endpointRows.has(input.id)) throw new WebhookError(`A webhook endpoint with id "${input.id}" already exists.`);
      if (endpointRows.size >= MAX_WEBHOOK_ENDPOINTS) throw new WebhookError(`At most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints.`, "webhook_endpoint_limit");
      const now = new Date();
      const row: StoredEndpoint = {
        id: input.id,
        url: valid.url,
        ...(valid.description !== undefined ? { description: valid.description } : {}),
        events: valid.events,
        organizations: valid.organizations,
        status: "enabled",
        consecutiveFailures: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: { ...input.createdBy },
        version: 1,
        secret: input.secret,
      };
      endpointRows.set(row.id, row);
      return publicEndpoint(row);
    },

    async update(id, input) {
      const valid = assertValidUpdateWebhookEndpoint(input);
      const row = get(id);
      assertWebhookVersion(row, input.expectedVersion);
      if (valid.url !== undefined) row.url = valid.url;
      if (valid.description !== undefined) {
        if (valid.description === null) delete row.description;
        else row.description = valid.description;
      }
      if (valid.events !== undefined) row.events = valid.events;
      if (valid.organizations !== undefined) row.organizations = valid.organizations;
      row.updatedAt = new Date();
      row.version += 1;
      return publicEndpoint(row);
    },

    async setStatus(id, status, input = {}) {
      const row = get(id);
      assertWebhookVersion(row, input.expectedVersion);
      const now = new Date();
      row.status = status;
      if (status === "disabled") {
        const reason = normalizeWebhookReason(input.reason);
        if (reason !== undefined) row.disabledReason = reason;
        else delete row.disabledReason;
        row.disabledAt = now;
      } else {
        delete row.disabledReason;
        delete row.disabledAt;
        row.consecutiveFailures = 0;
      }
      row.updatedAt = now;
      row.version += 1;
      return publicEndpoint(row);
    },

    async rotateSecret(id, input) {
      assertWebhookSecret(input.secret);
      const row = get(id);
      if (input.previousValidUntil) {
        row.previousSecret = row.secret;
        row.previousValidUntil = input.previousValidUntil;
      } else {
        delete row.previousSecret;
        delete row.previousValidUntil;
      }
      row.secret = input.secret;
      row.updatedAt = new Date();
      row.version += 1;
      return publicEndpoint(row);
    },

    async signingSecrets(id, now = new Date()) {
      const row = endpointRows.get(id);
      if (!row) return [];
      return row.previousSecret !== undefined && row.previousValidUntil !== undefined && row.previousValidUntil > now ? [row.secret, row.previousSecret] : [row.secret];
    },

    async recordAttempt(id, input) {
      const row = endpointRows.get(id);
      if (!row) return null;
      const at = input.at ?? new Date();
      if (input.success) {
        row.consecutiveFailures = 0;
        row.lastSuccessAt = at;
      } else {
        row.consecutiveFailures += 1;
        row.lastFailureAt = at;
        if (input.disableAfter !== undefined && row.status === "enabled" && row.consecutiveFailures >= input.disableAfter && at.getTime() - (row.lastSuccessAt ?? row.createdAt).getTime() >= (input.disableAfterMs ?? 0)) {
          row.status = "disabled";
          row.disabledReason = "too_many_failures";
          row.disabledAt = at;
          row.version += 1;
        }
      }
      row.updatedAt = at;
      return publicEndpoint(row);
    },

    async findById(id) {
      const row = endpointRows.get(id);
      return row ? publicEndpoint(row) : null;
    },

    async search(options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      return [...endpointRows.values()]
        .filter((row) => (options.status === undefined || row.status === options.status) && (options.after === undefined || row.id > options.after))
        .sort(byId)
        .slice(0, limit)
        .map(publicEndpoint);
    },

    async count(options = {}) {
      return [...endpointRows.values()].filter((row) => options.status === undefined || row.status === options.status).length;
    },

    async delete(id) {
      for (const [deliveryId, delivery] of deliveryRows) if (delivery.endpointId === id) deliveryRows.delete(deliveryId);
      return endpointRows.delete(id);
    },
  };

  const deliveries: WebhookDeliveryRepository = {
    async enqueue(input) {
      assertWebhookDelivery(input);
      if (!endpointRows.has(input.endpointId) || deliveryRows.has(input.id)) return false;
      const now = new Date();
      deliveryRows.set(input.id, {
        id: input.id,
        seq: ++seq,
        endpointId: input.endpointId,
        eventId: input.eventId,
        eventType: input.eventType,
        ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
        eventCreatedAt: input.eventCreatedAt,
        ...(input.payload !== undefined ? { payload: clone(input.payload) } : {}),
        status: "pending",
        attempts: 0,
        createdAt: now,
        availableAt: now,
      });
      return true;
    },

    async claim(options) {
      const { limit, leaseSeconds, now } = resolveWebhookClaim(options);
      const due = [...deliveryRows.values()]
        .filter((row) => row.status === "pending" && row.availableAt <= now && (row.leasedUntil === undefined || row.leasedUntil <= now) && endpointRows.get(row.endpointId)?.status === "enabled")
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      for (const row of due) {
        row.attempts += 1;
        row.leasedUntil = new Date(now.getTime() + leaseSeconds * 1000);
      }
      return due.map(publicDelivery);
    },

    async complete(id, input) {
      const row = deliveryRows.get(id);
      if (!row || row.status !== "pending") return false;
      row.status = "delivered";
      row.deliveredAt = input.at ?? new Date();
      row.lastHttpStatus = input.httpStatus;
      row.lastDurationMs = input.durationMs;
      delete row.leasedUntil;
      delete row.lastError;
      return true;
    },

    async fail(id, input) {
      const row = deliveryRows.get(id);
      if (!row || row.status !== "pending") return null;
      row.status = row.attempts >= input.maxAttempts ? "dead" : "pending";
      row.availableAt = input.retryAt;
      row.lastError = input.error;
      if (input.httpStatus !== undefined) row.lastHttpStatus = input.httpStatus;
      else delete row.lastHttpStatus;
      if (input.durationMs !== undefined) row.lastDurationMs = input.durationMs;
      delete row.leasedUntil;
      return row.status;
    },

    async requeue(id, now = new Date()) {
      const row = deliveryRows.get(id);
      if (!row || row.status !== "dead") return false;
      row.status = "pending";
      row.attempts = 0;
      row.availableAt = now;
      delete row.leasedUntil;
      delete row.lastError;
      return true;
    },

    async findById(id) {
      const row = deliveryRows.get(id);
      return row ? publicDelivery(row) : null;
    },

    async search(options: SearchWebhookDeliveriesOptions = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      return [...deliveryRows.values()]
        .filter(
          (row) =>
            (options.endpointId === undefined || row.endpointId === options.endpointId) &&
            (options.status === undefined || row.status === options.status) &&
            (options.eventType === undefined || row.eventType === options.eventType) &&
            (options.beforeSeq === undefined || row.seq < options.beforeSeq),
        )
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .map(publicDelivery);
    },

    async count(options = {}) {
      return [...deliveryRows.values()].filter((row) => (options.endpointId === undefined || row.endpointId === options.endpointId) && (options.status === undefined || row.status === options.status)).length;
    },

    async pruneDelivered(before) {
      let removed = 0;
      for (const [id, row] of deliveryRows) {
        if (row.status === "delivered" && row.deliveredAt !== undefined && row.deliveredAt < before) {
          deliveryRows.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };

  const scope: WebhookTransaction = { endpoints, deliveries, auditLogs };
  return {
    ...scope,
    // In-memory storage has no isolation to offer; the databases run the callback inside a transaction.
    transaction: (callback) => callback(scope),
  };
}
