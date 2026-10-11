import { endpointWants, signWebhook, webhookBackoffMs, webhookBody } from "@uniora/core";
import type { OutboxEvent, OutboxRepository, WebhookDelivery, WebhookEndpoint, WebhookStorage, WebhookUrlPolicy } from "@uniora/core";
import type { Logger } from "../logger.js";
import { sendWebhook } from "./send.js";
import type { SendWebhookInput, SendWebhookResult } from "./send.js";

export interface WebhookDispatcherOptions {
  /** The endpoints and their deliveries. */
  webhooks: WebhookStorage;
  /** The events to send: the outbox of your `UnioraStorage`. The dispatcher is its consumer (it completes what it fans out). */
  outbox: OutboxRepository;
  /** `allowInsecureHttp` / `allowPrivateNetworks` for development receivers. Never both on in production. */
  urlPolicy?: WebhookUrlPolicy;
  logger?: Logger;
  now?: () => Date;
  /** Deliveries in flight at once. Default 10, at most 50. */
  concurrency?: number;
  /** Deadline of one attempt. Default 10 s, at most 60 s. */
  timeoutMs?: number;
  /** Attempts before a delivery is parked as `dead`. Default 8 (about a day of retries). */
  maxAttempts?: number;
  /** Consecutive failed attempts that disable an endpoint. Default 50. */
  disableAfterFailures?: number;
  /** How long to wait when there was nothing to do. Default 1000 ms. */
  pollIntervalMs?: number;
  /** Delivered rows older than this are deleted, from the deliveries and the outbox. Default 7 days. */
  retainDeliveredDays?: number;
  /** Replace the HTTP sender (tests). */
  send?: (input: SendWebhookInput) => Promise<SendWebhookResult>;
}

export interface TickResult {
  /** Outbox events turned into deliveries. */
  readonly fannedOut: number;
  readonly delivered: number;
  readonly failed: number;
}

export interface WebhookDispatcher {
  /** Starts the background loop. Idempotent. */
  start(): void;
  /** Stops it and waits for the attempts in flight. Idempotent. */
  stop(): Promise<void>;
  /** One round: turn pending outbox events into deliveries, then send what is due. For tests, cron-style workers and `runOnce` commands. */
  tick(): Promise<TickResult>;
  /** Sends a `webhook.test` event to ONE endpoint now, outside the queue, so an operator can check a receiver. Never retried. */
  sendTest(endpointId: string): Promise<SendWebhookResult | null>;
}

const SUCCESS_HEADERS = "uniora-webhooks/1";
const HOUR_MS = 3_600_000;

function bounded(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw new RangeError(`webhooks.${name} must be an integer from ${min} to ${max}.`);
  return resolved;
}

export function createWebhookDispatcher(options: WebhookDispatcherOptions): WebhookDispatcher {
  const { webhooks, outbox } = options;
  const log: Logger = options.logger ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const send = options.send ?? sendWebhook;
  const concurrency = bounded("concurrency", options.concurrency, 10, 1, 50);
  const timeoutMs = bounded("timeoutMs", options.timeoutMs, 10_000, 1000, 60_000);
  const maxAttempts = bounded("maxAttempts", options.maxAttempts, 8, 1, 50);
  const disableAfter = bounded("disableAfterFailures", options.disableAfterFailures, 50, 1, 10_000);
  const pollIntervalMs = bounded("pollIntervalMs", options.pollIntervalMs, 1000, 10, 60_000);
  const retainMs = bounded("retainDeliveredDays", options.retainDeliveredDays, 7, 1, 365) * 24 * HOUR_MS;
  const FAN_OUT_BATCH = 50;

  let running = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let lastPrune = 0;

  async function fanOut(): Promise<number> {
    const events = await outbox.claim({ limit: FAN_OUT_BATCH, leaseSeconds: 60, now: now() });
    if (events.length === 0) return 0;
    const endpoints = await webhooks.endpoints.search({ status: "enabled", limit: 200 });
    const done: string[] = [];
    for (const event of events) {
      try {
        await fanOutOne(event, endpoints);
        done.push(event.id);
      } catch (error) {
        log({ level: "error", msg: "webhook fan-out failed", eventId: event.id, error });
        await outbox
          .fail(event.id, { error: "fan-out to webhook endpoints failed", retryAt: new Date(now().getTime() + webhookBackoffMs(event.attempts)), maxAttempts: 8 })
          .catch(() => undefined);
      }
    }
    // A crash between enqueueing and completing only repeats the fan-out, and the delivery ids make that harmless.
    if (done.length > 0) await outbox.complete(done, now());
    return done.length;
  }

  async function fanOutOne(event: OutboxEvent, endpoints: readonly WebhookEndpoint[]): Promise<void> {
    for (const endpoint of endpoints) {
      if (!endpointWants(endpoint, event)) continue;
      await webhooks.deliveries.enqueue({
        id: `${endpoint.id}:${event.id}`,
        endpointId: endpoint.id,
        eventId: event.id,
        eventType: event.type,
        organizationId: event.organizationId,
        eventCreatedAt: event.createdAt,
        payload: event.payload,
      });
    }
  }

  async function attempt(delivery: WebhookDelivery, endpoint: WebhookEndpoint): Promise<SendWebhookResult> {
    const secrets = await webhooks.endpoints.signingSecrets(endpoint.id, now());
    if (secrets.length === 0) return { ok: false, durationMs: 0, error: "the endpoint has no secret" };
    const body = webhookBody({ id: delivery.eventId, type: delivery.eventType, organizationId: delivery.organizationId, createdAt: delivery.eventCreatedAt, payload: delivery.payload });
    const timestamp = Math.floor(now().getTime() / 1000);
    return send({
      url: endpoint.url,
      body,
      timeoutMs,
      ...(options.urlPolicy ? { policy: options.urlPolicy } : {}),
      headers: {
        "content-type": "application/json",
        "user-agent": SUCCESS_HEADERS,
        "webhook-id": delivery.eventId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhook(secrets, delivery.eventId, timestamp, body),
      },
    });
  }

  async function deliverOne(delivery: WebhookDelivery, endpoints: Map<string, WebhookEndpoint | null>): Promise<boolean> {
    if (!endpoints.has(delivery.endpointId)) endpoints.set(delivery.endpointId, await webhooks.endpoints.findById(delivery.endpointId));
    const endpoint = endpoints.get(delivery.endpointId);
    if (!endpoint) return false; // deleted while queued: its deliveries go with it
    const result = await attempt(delivery, endpoint);
    if (result.ok) {
      await webhooks.deliveries.complete(delivery.id, { httpStatus: result.status ?? 200, durationMs: result.durationMs, at: now() });
      await webhooks.endpoints.recordAttempt(endpoint.id, { success: true, at: now() });
      return true;
    }
    const wait = result.retryAfterSeconds !== undefined ? result.retryAfterSeconds * 1000 : webhookBackoffMs(delivery.attempts);
    const state = await webhooks.deliveries.fail(delivery.id, {
      error: result.error ?? "failed",
      ...(result.status !== undefined ? { httpStatus: result.status } : {}),
      durationMs: result.durationMs,
      retryAt: new Date(now().getTime() + wait),
      maxAttempts,
    });
    const after = await webhooks.endpoints.recordAttempt(endpoint.id, { success: false, at: now(), disableAfter });
    // Hosts and ids only: the URL can carry a secret in its path, and the body is the organization's data.
    if (state === "dead") log({ level: "warn", msg: "webhook delivery gave up", endpointId: endpoint.id, eventId: delivery.eventId, attempts: delivery.attempts, error: result.error });
    if (after && after.status === "disabled" && endpoint.status === "enabled") log({ level: "warn", msg: "webhook endpoint disabled after repeated failures", endpointId: endpoint.id, consecutiveFailures: after.consecutiveFailures });
    endpoints.set(endpoint.id, after ?? endpoint);
    return false;
  }

  async function deliverDue(): Promise<{ delivered: number; failed: number }> {
    const due = await webhooks.deliveries.claim({ limit: Math.min(100, concurrency * 4), leaseSeconds: Math.ceil(timeoutMs / 1000) + 30, now: now() });
    if (due.length === 0) return { delivered: 0, failed: 0 };
    const endpoints = new Map<string, WebhookEndpoint | null>();
    let delivered = 0;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const delivery = due[next++]!;
        try {
          if (await deliverOne(delivery, endpoints)) delivered += 1;
          else failed += 1;
        } catch (error) {
          // Storage trouble: the lease runs out and the delivery is claimed again.
          log({ level: "error", msg: "webhook delivery bookkeeping failed", endpointId: delivery.endpointId, eventId: delivery.eventId, error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
    return { delivered, failed };
  }

  async function housekeeping(): Promise<void> {
    if (now().getTime() - lastPrune < HOUR_MS) return;
    lastPrune = now().getTime();
    const before = new Date(now().getTime() - retainMs);
    await webhooks.deliveries.pruneDelivered(before);
    await outbox.pruneDelivered(before);
  }

  async function tick(): Promise<TickResult> {
    const fannedOut = await fanOut();
    const { delivered, failed } = await deliverDue();
    await housekeeping().catch((error) => log({ level: "error", msg: "webhook housekeeping failed", error }));
    return { fannedOut, delivered, failed };
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function run(): Promise<void> {
    let failures = 0;
    while (running) {
      let busy = false;
      try {
        const result = await tick();
        busy = result.fannedOut + result.delivered + result.failed >= FAN_OUT_BATCH / 2;
        failures = 0;
      } catch (error) {
        failures += 1;
        // The same outage would otherwise log once per poll.
        if (failures === 1 || failures % 60 === 0) log({ level: "error", msg: "webhook dispatcher round failed", error });
      }
      if (running && !busy) await sleep(failures > 0 ? Math.min(30_000, pollIntervalMs * 2 ** Math.min(failures, 5)) : pollIntervalMs);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop = run();
    },
    async stop() {
      running = false;
      wake?.();
      await loop;
      loop = undefined;
    },
    tick,
    async sendTest(endpointId) {
      const endpoint = await webhooks.endpoints.findById(endpointId);
      if (!endpoint) return null;
      const delivery: WebhookDelivery = {
        id: `${endpoint.id}:test`,
        seq: 0,
        endpointId: endpoint.id,
        eventId: `evt_test_${now().getTime().toString(36)}`,
        eventType: "webhook.test",
        eventCreatedAt: now(),
        payload: { message: "This is a test event from UNIORA." },
        status: "pending",
        attempts: 1,
        createdAt: now(),
        availableAt: now(),
      };
      return attempt(delivery, endpoint);
    },
  };
}
