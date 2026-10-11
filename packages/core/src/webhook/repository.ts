import type { Identity } from "../identity/types.js";
import type { AuditLogRepository } from "../audit-log/repository.js";
import { WebhookError } from "./errors.js";
import { parseWebhookUrl } from "./network.js";
import { isWebhookSecret } from "./signature.js";
import type { WebhookDelivery, WebhookDeliveryStatus, WebhookEndpoint, WebhookEndpointStatus } from "./types.js";

export { WebhookError } from "./errors.js";
export type { WebhookErrorCode } from "./errors.js";

export const MAX_WEBHOOK_ENDPOINTS = 100;
export const MAX_WEBHOOK_DESCRIPTION_LENGTH = 200;
export const MAX_WEBHOOK_EVENT_PATTERNS = 50;
export const MAX_WEBHOOK_ORGANIZATIONS = 100;
export const MAX_WEBHOOK_CLAIM = 100;
export const MAX_WEBHOOK_LEASE_SECONDS = 3600;
/** The previous secret keeps signing for at most this long after a rotation, so a receiver can switch with no downtime. */
export const MAX_WEBHOOK_SECRET_GRACE_SECONDS = 7 * 24 * 3600;

export interface CreateWebhookEndpointInput {
  id: string;
  url: string;
  description?: string;
  events: readonly string[];
  organizations: "*" | readonly string[];
  /** `whsec_…`, stored as written: the worker needs it to sign. */
  secret: string;
  createdBy: Identity;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  description?: string | null;
  events?: readonly string[];
  organizations?: "*" | readonly string[];
  expectedVersion?: number;
}

export interface SearchWebhookEndpointsOptions {
  status?: WebhookEndpointStatus;
  limit?: number;
  /** Keyset cursor: the `id` of the last endpoint of the previous page; results are ordered by `id`. */
  after?: string;
}

export interface WebhookEndpointRepository {
  /** `webhook_endpoint_limit` at 100 endpoints. */
  create(input: CreateWebhookEndpointInput): Promise<WebhookEndpoint>;
  /** `webhook_endpoint_not_found`; `webhook_version_conflict` when `expectedVersion` is stale. */
  update(id: string, input: UpdateWebhookEndpointInput): Promise<WebhookEndpoint>;
  /** Enabling clears the failure count and the reason; disabling records `reason` (at most 200 characters). */
  setStatus(id: string, status: WebhookEndpointStatus, input?: { reason?: string; expectedVersion?: number }): Promise<WebhookEndpoint>;
  /** The new secret signs from now on; the one it replaces keeps signing until `previousValidUntil` (none: it stops at once). */
  rotateSecret(id: string, input: { secret: string; previousValidUntil?: Date }): Promise<WebhookEndpoint>;
  /** The secrets that sign a delivery now: the current one, and the previous one while its grace lasts. The ONLY way to read a secret back. */
  signingSecrets(id: string, now?: Date): Promise<string[]>;
  /**
   * What one delivery attempt did, atomically: a success resets the failure count; a failure adds one and, at `disableAfter`
   * consecutive failures, disables the endpoint (`too_many_failures`). `null` when the endpoint is gone.
   */
  recordAttempt(id: string, input: { success: boolean; at?: Date; disableAfter?: number }): Promise<WebhookEndpoint | null>;
  findById(id: string): Promise<WebhookEndpoint | null>;
  search(options?: SearchWebhookEndpointsOptions): Promise<WebhookEndpoint[]>;
  count(options?: Pick<SearchWebhookEndpointsOptions, "status">): Promise<number>;
  /** Deletes the endpoint and its deliveries. */
  delete(id: string): Promise<boolean>;
}

export interface EnqueueWebhookDeliveryInput {
  /** `<endpointId>:<eventId>`: a repeated id is ignored, so fanning the same event out twice cannot send it twice. */
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  organizationId?: string | undefined;
  eventCreatedAt: Date;
  payload?: Record<string, unknown> | undefined;
}

export interface ClaimWebhookDeliveriesOptions {
  /** Default 20, at most 100. */
  limit?: number;
  /** How long the claim holds a delivery before another worker may take it (a worker that died). Default 60, at most 3600. */
  leaseSeconds?: number;
  now?: Date;
}

export interface CompleteWebhookDeliveryInput {
  httpStatus: number;
  durationMs: number;
  at?: Date;
}

export interface FailWebhookDeliveryInput {
  /** Already sanitized text: it is stored and shown in operator screens. */
  error: string;
  httpStatus?: number;
  durationMs?: number;
  retryAt: Date;
  /** The delivery goes `dead` instead when its attempts reached this number. */
  maxAttempts: number;
}

export interface SearchWebhookDeliveriesOptions {
  endpointId?: string;
  status?: WebhookDeliveryStatus;
  eventType?: string;
  limit?: number;
  /** Keyset cursor: only deliveries whose `seq` is lower than this (newest first). */
  beforeSeq?: number;
}

export interface WebhookDeliveryRepository {
  /** Adds a pending delivery; `false` when that id already exists. A delivery for an endpoint that does not exist is not added (`false`). */
  enqueue(input: EnqueueWebhookDeliveryInput): Promise<boolean>;
  /** Pending, due, not leased, and of an ENABLED endpoint; oldest first. Concurrent workers never receive the same delivery while its lease holds. */
  claim(options?: ClaimWebhookDeliveriesOptions): Promise<WebhookDelivery[]>;
  /** `false` when it was not pending. */
  complete(id: string, input: CompleteWebhookDeliveryInput): Promise<boolean>;
  /** Back to `pending` at `retryAt`, or `dead` once `maxAttempts` is reached. `null` when it is no longer pending. */
  fail(id: string, input: FailWebhookDeliveryInput): Promise<WebhookDeliveryStatus | null>;
  /** A `dead` delivery goes back in the queue with its attempts reset; false when it isn't dead. */
  requeue(id: string, now?: Date): Promise<boolean>;
  findById(id: string): Promise<WebhookDelivery | null>;
  /** Newest first, keyset-paged by `seq`. */
  search(options?: SearchWebhookDeliveriesOptions): Promise<WebhookDelivery[]>;
  count(options?: { endpointId?: string; status?: WebhookDeliveryStatus }): Promise<number>;
  /** Deletes delivered deliveries delivered before `before`; returns how many. Pending and dead ones are never touched. */
  pruneDelivered(before: Date): Promise<number>;
}

export interface WebhookTransaction {
  readonly endpoints: WebhookEndpointRepository;
  readonly deliveries: WebhookDeliveryRepository;
  readonly auditLogs: AuditLogRepository;
}

/**
 * Webhook endpoints and their deliveries. Like the API credentials it is its OWN scope, outside `UnioraStorage`: it holds signing
 * secrets, so code that serves organizations never needs it.
 */
export interface WebhookStorage extends WebhookTransaction {
  transaction<T>(callback: (tx: WebhookTransaction) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation shared by every backend, so they reject the same things.

const EVENT_PATTERN = /^(?:\*|[a-z0-9_]+(?:\.[a-z0-9_]+)*(?:\.\*)?)$/;

export function assertWebhookId(id: unknown, what = "id"): asserts id is string {
  if (typeof id !== "string" || id === "" || id.length > 200) throw new WebhookError(`The ${what} must be a text of 1 to 200 characters.`);
}

export function normalizeWebhookEvents(events: unknown): string[] {
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_WEBHOOK_EVENT_PATTERNS) {
    throw new WebhookError(`Choose 1 to ${MAX_WEBHOOK_EVENT_PATTERNS} event types: an exact type, a prefix such as membership.*, or *.`, "webhook_events_invalid");
  }
  for (const event of events) {
    if (typeof event !== "string" || event.length > 120 || !EVENT_PATTERN.test(event)) {
      throw new WebhookError("An event type is lowercase words joined by dots, optionally ending in .* (or just *).", "webhook_events_invalid");
    }
  }
  return [...new Set(events as string[])].sort();
}

export function normalizeWebhookOrganizations(organizations: unknown): "*" | string[] {
  if (organizations === "*") return "*";
  if (!Array.isArray(organizations) || organizations.length === 0 || organizations.length > MAX_WEBHOOK_ORGANIZATIONS) {
    throw new WebhookError(`organizations is "*" or a list of 1 to ${MAX_WEBHOOK_ORGANIZATIONS} organization ids.`, "webhook_organizations_invalid");
  }
  for (const id of organizations) {
    // eslint-disable-next-line no-control-regex
    if (typeof id !== "string" || id === "" || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) throw new WebhookError("An organization id is a text of 1 to 200 characters.", "webhook_organizations_invalid");
  }
  return [...new Set(organizations as string[])].sort();
}

export function normalizeWebhookDescription(description: unknown): string | undefined {
  if (description === undefined) return undefined;
  if (typeof description !== "string") throw new WebhookError("The description must be text.");
  // eslint-disable-next-line no-control-regex
  const text = description.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (text.length > MAX_WEBHOOK_DESCRIPTION_LENGTH) throw new WebhookError(`The description cannot exceed ${MAX_WEBHOOK_DESCRIPTION_LENGTH} characters.`);
  return text === "" ? undefined : text;
}

export function assertWebhookSecret(secret: unknown): asserts secret is string {
  if (!isWebhookSecret(secret)) throw new WebhookError("The secret must look like whsec_ followed by 44 base64 characters.");
}

/** Whether an event of `type` in `organizationId` is for `endpoint`. */
export function endpointWants(endpoint: Pick<WebhookEndpoint, "events" | "organizations">, event: { type: string; organizationId?: string | undefined }): boolean {
  if (endpoint.organizations !== "*" && (event.organizationId === undefined || !endpoint.organizations.includes(event.organizationId))) return false;
  return endpoint.events.some((pattern) => pattern === "*" || pattern === event.type || (pattern.endsWith(".*") && event.type.startsWith(pattern.slice(0, -1))));
}

export function resolveWebhookClaim(options: ClaimWebhookDeliveriesOptions = {}): { limit: number; leaseSeconds: number; now: Date } {
  const limit = options.limit ?? 20;
  const leaseSeconds = options.leaseSeconds ?? 60;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WEBHOOK_CLAIM) throw new WebhookError(`limit must be an integer between 1 and ${MAX_WEBHOOK_CLAIM}.`);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > MAX_WEBHOOK_LEASE_SECONDS) throw new WebhookError(`leaseSeconds must be an integer between 1 and ${MAX_WEBHOOK_LEASE_SECONDS}.`);
  return { limit, leaseSeconds, now: options.now ?? new Date() };
}

export function assertWebhookDelivery(input: EnqueueWebhookDeliveryInput): void {
  assertWebhookId(input.id, "delivery id");
  assertWebhookId(input.endpointId, "endpoint id");
  assertWebhookId(input.eventId, "event id");
  if (typeof input.eventType !== "string" || input.eventType === "" || input.eventType.length > 120) throw new WebhookError("The event type must be a text of 1 to 120 characters.");
  if (input.payload !== undefined && Buffer.byteLength(JSON.stringify(input.payload), "utf8") > 16 * 1024) throw new WebhookError("The payload cannot exceed 16384 bytes.");
}

export function normalizeWebhookReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const text = String(reason).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text === "" ? undefined : text.slice(0, 200);
}

/** What a backend checks of a URL: its shape. Whether the host is acceptable (private networks, plain http) is the service's policy. */
export function normalizeWebhookUrl(url: unknown): string {
  return parseWebhookUrl(url, { allowInsecureHttp: true, allowPrivateNetworks: true }).toString();
}

export function assertWebhookVersion(row: { version: number }, expected: number | undefined): void {
  if (expected !== undefined && expected !== row.version) throw new WebhookError("The webhook endpoint changed since it was read.", "webhook_version_conflict");
}

/** Everything `create` needs, checked and normalized. */
export function assertValidCreateWebhookEndpoint(input: CreateWebhookEndpointInput) {
  assertWebhookId(input.id, "endpoint id");
  assertWebhookSecret(input.secret);
  return {
    url: normalizeWebhookUrl(input.url),
    description: normalizeWebhookDescription(input.description),
    events: normalizeWebhookEvents(input.events),
    organizations: normalizeWebhookOrganizations(input.organizations),
  };
}

export function assertValidUpdateWebhookEndpoint(input: UpdateWebhookEndpointInput) {
  const keys = ["url", "description", "events", "organizations"] as const;
  if (!keys.some((key) => input[key] !== undefined)) throw new WebhookError("There is nothing to change.");
  return {
    url: input.url !== undefined ? normalizeWebhookUrl(input.url) : undefined,
    description: input.description === undefined ? undefined : input.description === null ? null : (normalizeWebhookDescription(input.description) ?? null),
    events: input.events !== undefined ? normalizeWebhookEvents(input.events) : undefined,
    organizations: input.organizations !== undefined ? normalizeWebhookOrganizations(input.organizations) : undefined,
  };
}

/** Delay before the next attempt: 30 s, 1 min, 2 min... capped at 1 h, with up to 25 % jitter so retries of one outage do not arrive together. */
export function webhookBackoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (1 + 0.25 * random()));
}
