import { sanitizeDeliveryError } from "../invitation/delivery.js";
import type { OutboxRepository } from "./repository.js";
import type { OutboxEvent } from "./types.js";

export interface DispatchOutboxOptions {
  /** Events taken per pass (default 20, at most 100). */
  batchSize?: number;
  /** How long a claimed batch is held (default 60 s). Longer than the slowest handler call. */
  leaseSeconds?: number;
  /** Deliveries before an event is parked as `dead` (default 8). */
  maxAttempts?: number;
  /** First retry delay; doubles with each attempt (default 30 s). */
  backoffSeconds?: number;
  /** Largest retry delay (default 1 hour). */
  maxBackoffSeconds?: number;
  /** Secrets to scrub from stored error messages (webhook URLs, tokens). */
  secrets?: readonly string[];
  now?: () => Date;
}

export interface DispatchOutboxResult {
  claimed: number;
  delivered: number;
  /** Failed and scheduled for another try. */
  retried: number;
  /** Failed for the last time: parked until someone `requeue`s them. */
  dead: number;
}

/** The delay before the next try after `attempts` deliveries: `backoffSeconds * 2^(attempts - 1)`, capped. */
export function outboxBackoffSeconds(attempts: number, backoffSeconds = 30, maxBackoffSeconds = 3600): number {
  return Math.min(maxBackoffSeconds, backoffSeconds * 2 ** Math.max(0, attempts - 1));
}

/**
 * One delivery pass: claims a batch, hands each event to `handler` in order and records the outcome. A handler that
 * throws schedules a retry with exponential backoff (and, after `maxAttempts`, parks the event as `dead`); it never
 * stops the rest of the batch. Call it from a scheduler, a loop or a serverless cron; several instances may run at once.
 * Delivery is at least once, so `handler` must be idempotent by `event.id`.
 */
export async function dispatchOutbox(
  outbox: OutboxRepository,
  handler: (event: OutboxEvent) => Promise<void> | void,
  options: DispatchOutboxOptions = {},
): Promise<DispatchOutboxResult> {
  const { batchSize = 20, leaseSeconds = 60, maxAttempts = 8, backoffSeconds = 30, maxBackoffSeconds = 3600, secrets = [] } = options;
  const clock = options.now ?? (() => new Date());
  const events = await outbox.claim({ limit: batchSize, leaseSeconds, now: clock() });
  const result: DispatchOutboxResult = { claimed: events.length, delivered: 0, retried: 0, dead: 0 };
  for (const event of events) {
    try {
      await handler(event);
    } catch (error) {
      const at = clock();
      const retryAt = new Date(at.getTime() + outboxBackoffSeconds(event.attempts, backoffSeconds, maxBackoffSeconds) * 1000);
      const status = await outbox.fail(event.id, { error: sanitizeDeliveryError(error, secrets), retryAt, maxAttempts });
      if (status === "dead") result.dead += 1;
      else if (status === "pending") result.retried += 1;
      continue;
    }
    result.delivered += await outbox.complete([event.id], clock());
  }
  return result;
}
