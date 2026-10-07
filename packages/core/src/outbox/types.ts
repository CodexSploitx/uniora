export type OutboxStatus = "pending" | "delivered" | "dead";

/** An event waiting to be delivered (or already delivered, or given up on) after the change that produced it committed. */
export interface OutboxEvent {
  readonly id: string;
  /** Strictly increasing per storage: claims hand events out in this order. */
  readonly seq: number;
  readonly organizationId?: string;
  /** What happened, e.g. `member.blocked` (UNIORA's own events reuse the audit action names). */
  readonly type: string;
  readonly payload?: Record<string, unknown>;
  readonly status: OutboxStatus;
  /** Times a worker has claimed it. */
  readonly attempts: number;
  readonly createdAt: Date;
  /** Not claimable before this moment (retry backoff). */
  readonly availableAt: Date;
  readonly deliveredAt?: Date;
  /** Sanitised message of the last failed delivery. */
  readonly lastError?: string;
}
