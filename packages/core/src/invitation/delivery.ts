import type { Identity } from "../identity/types.js";

/** Everything a sender needs to write and address the e-mail. Contains the secret link: never log it. */
export interface InvitationMessage {
  invitationId: string;
  /** Normalized recipient address. */
  to: string;
  organization: { id: string; name: string; slug: string };
  roleNames: string[];
  invitedBy: Identity;
  /** The full link, token included. */
  acceptUrl: string;
  expiresAt: Date;
  /** Language hint from the caller (e.g. `"es"`); senders fall back to their own default. */
  locale?: string;
}

export interface SendContext {
  /** Aborted when the attempt exceeds its time budget; pass it to your HTTP/SMTP client. */
  signal: AbortSignal;
  /** 1-based attempt number within this send. */
  attempt: number;
}

/**
 * The seam between UNIORA and whatever delivers mail: SMTP (`@uniora/mailer-smtp`),
 * Resend, SES, a queue... Throw to signal failure. Throw an
 * `InvitationDeliveryError` with `permanent: true` for failures retrying can't
 * fix (rejected recipient, bad credentials); anything else is retried.
 *
 * Make `send` safe to call twice for the same `invitationId` (it may be
 * retried after a timeout that actually delivered).
 */
export interface InvitationSender {
  send(message: InvitationMessage, context: SendContext): Promise<void>;
}

export class InvitationDeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InvitationDeliveryError";
  }
}

export interface DeliveryRetryOptions {
  /** Attempts per send, first one included. Default 3. */
  maxAttempts?: number;
  /** First backoff; doubles each retry, with full jitter. Default 500 ms. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt time budget. Default 15 s. */
  attemptTimeoutMs?: number;
}

export interface SendOutcome {
  status: "sent" | "failed";
  attempts: number;
  error?: string;
}

const MAX_ERROR_LENGTH = 500;

/** Error text safe to persist: secrets removed, control characters flattened, length-capped. */
export function sanitizeDeliveryError(error: unknown, secrets: readonly string[]): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/https?:\/\/\S*uinv_\S*/g, "[redacted]").replace(/uinv_[A-Za-z0-9_-]+/g, "[redacted]");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(run: (signal: AbortSignal) => Promise<void>, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new InvitationDeliveryError(`Delivery attempt timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });
  try {
    await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One logical send: up to `maxAttempts` tries with exponential backoff and
 * full jitter, each under its own timeout. Never throws — the outcome is the
 * result, so a flaky mail provider can't fail the request that created the
 * invitation (the invitation exists either way and can be re-sent).
 */
export async function sendWithRetry(
  sender: InvitationSender,
  message: InvitationMessage,
  options: {
    retry?: DeliveryRetryOptions;
    secrets?: readonly string[];
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
  } = {},
): Promise<SendOutcome> {
  const maxAttempts = Math.max(1, Math.floor(options.retry?.maxAttempts ?? 3));
  const baseDelayMs = options.retry?.baseDelayMs ?? 500;
  const maxDelayMs = options.retry?.maxDelayMs ?? 10_000;
  const attemptTimeoutMs = options.retry?.attemptTimeoutMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const secrets = options.secrets ?? [];

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await withTimeout((signal) => sender.send(message, { signal, attempt }), attemptTimeoutMs);
      return { status: "sent", attempts: attempt };
    } catch (error) {
      lastError = error;
      const permanent = error instanceof InvitationDeliveryError && error.permanent;
      if (permanent || attempt === maxAttempts) {
        return { status: "failed", attempts: attempt, error: sanitizeDeliveryError(error, secrets) };
      }
      await sleep(Math.floor(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))));
    }
  }
  return { status: "failed", attempts: maxAttempts, error: sanitizeDeliveryError(lastError, secrets) };
}
