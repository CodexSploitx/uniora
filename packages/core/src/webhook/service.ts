import { randomUUID } from "node:crypto";
import type { Identity } from "../identity/types.js";
import { randomBase62 } from "../api/key.js";
import { WebhookError } from "./errors.js";
import { parseWebhookUrl } from "./network.js";
import type { WebhookUrlPolicy } from "./network.js";
import { MAX_WEBHOOK_SECRET_GRACE_SECONDS, assertWebhookId, normalizeWebhookEvents, normalizeWebhookOrganizations } from "./repository.js";
import type { SearchWebhookDeliveriesOptions, SearchWebhookEndpointsOptions, WebhookStorage, WebhookTransaction } from "./repository.js";
import { generateWebhookSecret } from "./signature.js";
import type { WebhookDelivery, WebhookEndpoint } from "./types.js";

export interface WebhookServiceOptions {
  storage: WebhookStorage;
  /** Which URLs may be registered. Defaults to the safe one: `https` and a public host. */
  urlPolicy?: WebhookUrlPolicy;
  now?: () => Date;
}

export interface CreatedWebhookEndpoint {
  readonly endpoint: WebhookEndpoint;
  /** `whsec_…`. THE ONLY TIME IT IS SHOWN (or after a rotation): it is not returned by any read. Never log it. */
  readonly secret: string;
}

/**
 * Creates and manages webhook endpoints and audits every change with the operator who made it. For operators (Studio, the CLI):
 * no API route manages webhooks, because an endpoint is a place where the events of EVERY organization are sent.
 */
export interface WebhookService {
  createEndpoint(input: { actor: Identity; url: string; events: readonly string[]; organizations?: "*" | readonly string[]; description?: string; id?: string }): Promise<CreatedWebhookEndpoint>;
  updateEndpoint(input: {
    actor: Identity;
    endpointId: string;
    url?: string;
    events?: readonly string[];
    organizations?: "*" | readonly string[];
    description?: string | null;
    expectedVersion?: number;
  }): Promise<WebhookEndpoint>;
  /** Deliveries wait while an endpoint is disabled and are sent when it is enabled again. */
  disableEndpoint(input: { actor: Identity; endpointId: string; reason?: string; expectedVersion?: number }): Promise<WebhookEndpoint>;
  enableEndpoint(input: { actor: Identity; endpointId: string; expectedVersion?: number }): Promise<WebhookEndpoint>;
  /** A new secret signs from now on; the old one keeps signing for `graceSeconds` (default 24 h, at most 7 days, `0` = stop at once). */
  rotateSecret(input: { actor: Identity; endpointId: string; graceSeconds?: number }): Promise<CreatedWebhookEndpoint>;
  deleteEndpoint(input: { actor: Identity; endpointId: string }): Promise<void>;
  /** Puts a `dead` delivery back in the queue. */
  requeueDelivery(input: { actor: Identity; deliveryId: string }): Promise<WebhookDelivery>;

  getEndpoint(endpointId: string): Promise<WebhookEndpoint | null>;
  listEndpoints(options?: SearchWebhookEndpointsOptions): Promise<WebhookEndpoint[]>;
  countEndpoints(options?: Pick<SearchWebhookEndpointsOptions, "status">): Promise<number>;
  listDeliveries(options?: SearchWebhookDeliveriesOptions): Promise<WebhookDelivery[]>;
}

const hostOf = (url: string): string => new URL(url).host;

export function createWebhookService(options: WebhookServiceOptions): WebhookService {
  const { storage } = options;
  const now = options.now ?? (() => new Date());

  async function audit(tx: WebhookTransaction, actor: Identity, action: string, endpoint: { id: string }, metadata: Record<string, unknown>): Promise<void> {
    // The URL can carry a secret in its path: the trail names the host only.
    await tx.auditLogs.record({ id: randomUUID(), actor, action, target: { type: "webhook_endpoint", id: endpoint.id }, metadata });
  }

  const identity = (actor: Identity): void => {
    if (!actor || typeof actor.provider !== "string" || typeof actor.subject !== "string" || actor.provider === "" || actor.subject === "") {
      throw new WebhookError("The actor must have a provider and a subject.");
    }
  };

  const orgMeta = (organizations: "*" | readonly string[]) => (organizations === "*" ? { organizations: "*" } : { organizationCount: organizations.length });

  async function setStatus(input: { actor: Identity; endpointId: string; reason?: string; expectedVersion?: number }, status: "enabled" | "disabled"): Promise<WebhookEndpoint> {
    identity(input.actor);
    assertWebhookId(input.endpointId, "endpoint id");
    return storage.transaction(async (tx) => {
      const endpoint = await tx.endpoints.setStatus(input.endpointId, status, {
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
      });
      await audit(tx, input.actor, status === "enabled" ? "webhook_endpoint.enabled" : "webhook_endpoint.disabled", endpoint, { version: endpoint.version });
      return endpoint;
    });
  }

  return {
    async createEndpoint(input) {
      identity(input.actor);
      const url = parseWebhookUrl(input.url, options.urlPolicy).toString();
      const events = normalizeWebhookEvents(input.events);
      const organizations = normalizeWebhookOrganizations(input.organizations ?? "*");
      const secret = generateWebhookSecret();
      const id = input.id ?? `whe_${randomBase62(16)}`;
      return storage.transaction(async (tx) => {
        const endpoint = await tx.endpoints.create({
          id,
          url,
          ...(input.description !== undefined ? { description: input.description } : {}),
          events,
          organizations,
          secret,
          createdBy: input.actor,
        });
        await audit(tx, input.actor, "webhook_endpoint.created", endpoint, { host: hostOf(url), events, ...orgMeta(organizations) });
        return { endpoint, secret };
      });
    },

    async updateEndpoint(input) {
      identity(input.actor);
      assertWebhookId(input.endpointId, "endpoint id");
      const url = input.url !== undefined ? parseWebhookUrl(input.url, options.urlPolicy).toString() : undefined;
      return storage.transaction(async (tx) => {
        const endpoint = await tx.endpoints.update(input.endpointId, {
          ...(url !== undefined ? { url } : {}),
          ...(input.events !== undefined ? { events: input.events } : {}),
          ...(input.organizations !== undefined ? { organizations: input.organizations } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        });
        await audit(tx, input.actor, "webhook_endpoint.updated", endpoint, {
          changed: [url !== undefined && "url", input.events !== undefined && "events", input.organizations !== undefined && "organizations", input.description !== undefined && "description"].filter(Boolean),
          ...(url !== undefined ? { host: hostOf(url) } : {}),
          ...(input.events !== undefined ? { events: endpoint.events } : {}),
          ...(input.organizations !== undefined ? orgMeta(endpoint.organizations) : {}),
          version: endpoint.version,
        });
        return endpoint;
      });
    },

    disableEndpoint: (input) => setStatus(input, "disabled"),
    enableEndpoint: (input) => setStatus(input, "enabled"),

    async rotateSecret(input) {
      identity(input.actor);
      assertWebhookId(input.endpointId, "endpoint id");
      const grace = input.graceSeconds ?? 24 * 3600;
      if (!Number.isInteger(grace) || grace < 0 || grace > MAX_WEBHOOK_SECRET_GRACE_SECONDS) throw new WebhookError(`graceSeconds is an integer from 0 to ${MAX_WEBHOOK_SECRET_GRACE_SECONDS}.`);
      const secret = generateWebhookSecret();
      return storage.transaction(async (tx) => {
        const endpoint = await tx.endpoints.rotateSecret(input.endpointId, { secret, ...(grace > 0 ? { previousValidUntil: new Date(now().getTime() + grace * 1000) } : {}) });
        await audit(tx, input.actor, "webhook_endpoint.secret_rotated", endpoint, { graceSeconds: grace, version: endpoint.version });
        return { endpoint, secret };
      });
    },

    async deleteEndpoint(input) {
      identity(input.actor);
      assertWebhookId(input.endpointId, "endpoint id");
      await storage.transaction(async (tx) => {
        const endpoint = await tx.endpoints.findById(input.endpointId);
        if (!endpoint) throw new WebhookError(`Webhook endpoint not found: ${input.endpointId}`, "webhook_endpoint_not_found");
        await tx.endpoints.delete(input.endpointId);
        await audit(tx, input.actor, "webhook_endpoint.deleted", endpoint, { host: hostOf(endpoint.url) });
      });
    },

    async requeueDelivery(input) {
      identity(input.actor);
      assertWebhookId(input.deliveryId, "delivery id");
      return storage.transaction(async (tx) => {
        const before = await tx.deliveries.findById(input.deliveryId);
        if (!before) throw new WebhookError(`Webhook delivery not found: ${input.deliveryId}`, "webhook_delivery_not_found");
        if (!(await tx.deliveries.requeue(input.deliveryId, now()))) throw new WebhookError("Only a dead delivery can be sent again.");
        await audit(tx, input.actor, "webhook_delivery.requeued", { id: before.endpointId }, { deliveryId: before.id, eventId: before.eventId });
        return (await tx.deliveries.findById(input.deliveryId))!;
      });
    },

    getEndpoint: (endpointId) => storage.endpoints.findById(endpointId),
    listEndpoints: (searchOptions) => storage.endpoints.search(searchOptions),
    countEndpoints: (countOptions) => storage.endpoints.count(countOptions),
    listDeliveries: (searchOptions) => storage.deliveries.search(searchOptions),
  };
}
