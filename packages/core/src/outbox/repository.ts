import { UnioraError } from "../shared/errors.js";
import type { OutboxEvent, OutboxStatus } from "./types.js";

export type OutboxErrorCode = "outbox_event_invalid" | "outbox_payload_invalid" | "outbox_event_exists" | "outbox_claim_invalid";

export class OutboxError extends UnioraError {
  constructor(message: string, code: OutboxErrorCode = "outbox_event_invalid") {
    super(message, code);
    this.name = "OutboxError";
  }
}

export const MAX_OUTBOX_TYPE_LENGTH = 120;
/** Serialized size cap of a payload: events carry ids and facts, not documents. */
export const MAX_OUTBOX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_OUTBOX_CLAIM = 100;
export const MAX_OUTBOX_LEASE_SECONDS = 3600;

export interface EnqueueOutboxInput {
  id: string;
  type: string;
  organizationId?: string;
  /** JSON-serializable, at most 16 KB. Never put secrets here: workers and queues see it. */
  payload?: Record<string, unknown>;
}

export interface ClaimOutboxOptions {
  /** Default 20, at most 100. */
  limit?: number;
  /**
   * How long the claim holds the events before another worker may take them again (a worker that died mid-batch).
   * Default 60, at most 3600.
   */
  leaseSeconds?: number;
  /** Only events of this type (exact match) or organization. */
  type?: string;
  organizationId?: string;
  /** The clock, for tests and for a worker that wants one reading per batch. */
  now?: Date;
}

export interface FailOutboxInput {
  /** Already sanitised: this text is stored and shown in operator screens. */
  error: string;
  /** When the event may be claimed again. */
  retryAt: Date;
  /** The event goes `dead` instead when its attempts reached this number. */
  maxAttempts: number;
}

export interface SearchOutboxOptions {
  status?: OutboxStatus;
  organizationId?: string;
  type?: string;
  limit?: number;
  /** Keyset cursor: only events whose `seq` is greater than this. */
  afterSeq?: number;
}

/**
 * Events that must reach other systems (a webhook, a queue, a cache invalidation, an e-mail) ONLY if the change that
 * produced them committed. `enqueue` runs inside the same transaction as the change, so a rolled-back change leaves no
 * event and a committed one can't lose it; a worker delivers them afterwards. Delivery is **at least once**: a handler
 * may see an event twice (a crash after delivering, an expired lease), so make it idempotent by `event.id`.
 */
export interface OutboxRepository {
  /** Adds a pending event. A repeated `id` is rejected (`outbox_event_exists`), so a retried transaction can't duplicate it. */
  enqueue(input: EnqueueOutboxInput): Promise<OutboxEvent>;
  /**
   * Takes up to `limit` deliverable events (pending, due, not leased by someone else), oldest first, and leases them to
   * the caller. Concurrent workers never receive the same event while its lease holds.
   */
  claim(options?: ClaimOutboxOptions): Promise<OutboxEvent[]>;
  /** Marks claimed events delivered; returns how many changed (a non-pending id is ignored). */
  complete(ids: string[], now?: Date): Promise<number>;
  /** Records a failed delivery: back to `pending` with a retry time, or `dead` once `maxAttempts` is reached. `null` when the event is no longer pending. */
  fail(id: string, input: FailOutboxInput): Promise<OutboxStatus | null>;
  /** Puts a `dead` event back in the queue with its attempts reset; false when it isn't dead. */
  requeue(id: string, now?: Date): Promise<boolean>;
  findById(id: string): Promise<OutboxEvent | null>;
  /** Oldest first, keyset-paged by `seq`. For operator screens ("what is stuck?"). */
  search(options?: SearchOutboxOptions): Promise<OutboxEvent[]>;
  count(options?: { status?: OutboxStatus; organizationId?: string; type?: string }): Promise<number>;
  /** Deletes delivered events delivered before `before`; returns how many. Pending and dead events are never touched. */
  pruneDelivered(before: Date): Promise<number>;
}

/** Validates an `enqueue` input; shared by every backend so they reject the same things. */
export function assertValidOutboxEvent(input: EnqueueOutboxInput): void {
  if (typeof input.id !== "string" || input.id.trim() === "" || input.id.length > 200) {
    throw new OutboxError("The event id must be a non-empty text of at most 200 characters.");
  }
  if (typeof input.type !== "string" || input.type.trim() === "" || input.type.length > MAX_OUTBOX_TYPE_LENGTH) {
    throw new OutboxError(`The event type must be a non-empty text of at most ${MAX_OUTBOX_TYPE_LENGTH} characters.`);
  }
  if (input.payload !== undefined) {
    let size: number;
    try {
      if (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload)) throw new Error("not an object");
      size = Buffer.byteLength(JSON.stringify(input.payload), "utf8");
    } catch {
      throw new OutboxError("The event payload must be a JSON-serializable object.", "outbox_payload_invalid");
    }
    if (size > MAX_OUTBOX_PAYLOAD_BYTES) {
      throw new OutboxError(`The event payload cannot exceed ${MAX_OUTBOX_PAYLOAD_BYTES} bytes.`, "outbox_payload_invalid");
    }
  }
}

/** Normalises claim options (defaults and caps), rejecting nonsense instead of clamping it silently. */
export function resolveClaimOptions(options: ClaimOutboxOptions = {}): { limit: number; leaseSeconds: number; now: Date } {
  const limit = options.limit ?? 20;
  const leaseSeconds = options.leaseSeconds ?? 60;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTBOX_CLAIM) {
    throw new OutboxError(`limit must be an integer between 1 and ${MAX_OUTBOX_CLAIM}.`, "outbox_claim_invalid");
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > MAX_OUTBOX_LEASE_SECONDS) {
    throw new OutboxError(`leaseSeconds must be an integer between 1 and ${MAX_OUTBOX_LEASE_SECONDS}.`, "outbox_claim_invalid");
  }
  return { limit, leaseSeconds, now: options.now ?? new Date() };
}
