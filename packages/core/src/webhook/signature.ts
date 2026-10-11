import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signing follows the Standard Webhooks scheme (the one Svix, Clerk and others use), so receivers can verify with a library they
 * may already have:
 *
 * - `webhook-id`: the event id, the same on every retry of a delivery (use it to deduplicate: delivery is at least once).
 * - `webhook-timestamp`: unix seconds of THIS attempt.
 * - `webhook-signature`: `v1,<base64 HMAC-SHA256>` of `<id>.<timestamp>.<body>`, one per active secret, separated by spaces.
 *
 * The secret is `whsec_` plus 32 random bytes in base64.
 */
export const WEBHOOK_SECRET_PREFIX = "whsec_";
const SECRET_PATTERN = /^whsec_[A-Za-z0-9+/]{43}=$/;

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
}

export const isWebhookSecret = (value: unknown): value is string => typeof value === "string" && SECRET_PATTERN.test(value);

const keyOf = (secret: string): Buffer => {
  if (!isWebhookSecret(secret)) throw new TypeError("A webhook secret looks like whsec_ followed by 44 base64 characters.");
  return Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), "base64");
};

const signOne = (secret: string, id: string, timestamp: number, body: string): Buffer => createHmac("sha256", keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest();

/** The `webhook-signature` header value for `secrets` (the current one, and the previous one during a rotation). */
export function signWebhook(secrets: readonly string[], id: string, timestamp: number, body: string): string {
  if (secrets.length === 0) throw new TypeError("Signing needs at least one secret.");
  return secrets.map((secret) => `v1,${signOne(secret, id, timestamp, body).toString("base64")}`).join(" ");
}

export interface VerifyWebhookInput {
  /** The raw body exactly as received: parse it only after this returns true. */
  body: string;
  /** The `webhook-id`, `webhook-timestamp` and `webhook-signature` headers. */
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined };
  /** The endpoint's secret(s): pass both during a rotation. */
  secrets: string | readonly string[];
  /** How far the timestamp may be from now, either way. Default 300 s: it is what stops a captured delivery from being replayed later. */
  toleranceSeconds?: number;
  now?: Date;
}

/** Whether a delivery really comes from your UNIORA server and is recent. Constant-time. Never throws on bad input. */
export function verifyWebhook(input: VerifyWebhookInput): boolean {
  const { id, timestamp, signature } = input.headers;
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signature !== "string" || typeof input.body !== "string") return false;
  if (!/^\d{1,12}$/.test(timestamp) || id === "" || id.length > 200) return false;
  const seconds = Number(timestamp);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - seconds) > (input.toleranceSeconds ?? 300)) return false;
  const secrets = typeof input.secrets === "string" ? [input.secrets] : input.secrets;
  const given = signature.split(" ").filter((part) => part.startsWith("v1,")).map((part) => Buffer.from(part.slice(3), "base64"));
  let ok = false;
  for (const secret of secrets) {
    if (!isWebhookSecret(secret)) continue;
    const expected = signOne(secret, id, seconds, input.body);
    for (const candidate of given) {
      // Every pair is compared, so the time taken does not say which one matched.
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) ok = true;
    }
  }
  return ok;
}

/** The body a receiver gets: a stable envelope, so the event can grow without breaking anyone. */
export function webhookBody(event: { id: string; type: string; organizationId?: string | undefined; createdAt: Date; payload?: Record<string, unknown> | undefined }): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    ...(event.organizationId !== undefined ? { organizationId: event.organizationId } : {}),
    createdAt: event.createdAt.toISOString(),
    data: event.payload ?? {},
  });
}
