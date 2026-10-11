import type { Identity } from "../identity/types.js";

export const WEBHOOK_ENDPOINT_STATUSES = ["enabled", "disabled"] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

/**
 * Where UNIORA sends the events that happen (a member blocked, a role changed...) and which of them. The secret that signs the
 * deliveries is NOT part of this: it is shown once, when the endpoint is created or its secret rotated, and read back only by the
 * delivery worker (`signingSecrets`).
 */
export interface WebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly description?: string;
  /** What it receives: an exact event type (`membership.blocked`), a prefix (`membership.*`) or everything (`*`). */
  readonly events: readonly string[];
  /** The organizations whose events it receives, or all of them. */
  readonly organizations: "*" | readonly string[];
  readonly status: WebhookEndpointStatus;
  /** Why it was disabled: `too_many_failures` when the worker did it, or the operator's own words. */
  readonly disabledReason?: string;
  readonly disabledAt?: Date;
  /** Failed delivery attempts in a row; a success resets it. At the configured threshold the endpoint is disabled. */
  readonly consecutiveFailures: number;
  readonly lastSuccessAt?: Date;
  readonly lastFailureAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdBy: Identity;
  readonly version: number;
}

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "dead"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** One event for one endpoint: its own retries, its own outcome. */
export interface WebhookDelivery {
  readonly id: string;
  readonly seq: number;
  readonly endpointId: string;
  /** The outbox event it carries; also the `webhook-id` the receiver sees, the same on every retry. */
  readonly eventId: string;
  readonly eventType: string;
  readonly organizationId?: string;
  readonly eventCreatedAt: Date;
  readonly payload?: Record<string, unknown>;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly availableAt: Date;
  readonly deliveredAt?: Date;
  /** The sanitized failure of the last attempt (never the response body). */
  readonly lastError?: string;
  readonly lastHttpStatus?: number;
  readonly lastDurationMs?: number;
}
