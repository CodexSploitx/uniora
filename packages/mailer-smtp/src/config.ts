/**
 * SMTP settings, read from the environment. UNIORA never ships credentials and
 * never guesses: the mailer refuses to start until the minimum is present, and
 * says everything that is wrong in one error.
 *
 *   UNIORA_SMTP_HOST      required   e.g. smtp.postmarkapp.com
 *   UNIORA_SMTP_PORT      587        465 = implicit TLS, 587/25 = STARTTLS
 *   UNIORA_SMTP_SECURE    auto       "true" for implicit TLS (default: true only on 465)
 *   UNIORA_SMTP_USER      optional   with PASS; both or neither
 *   UNIORA_SMTP_PASS      optional
 *   UNIORA_SMTP_FROM      required   "Acme <no-reply@acme.com>" or a bare address
 *   UNIORA_SMTP_REPLY_TO  optional
 *   UNIORA_SMTP_REQUIRE_TLS        true   refuse to send over a plain-text connection
 *   UNIORA_SMTP_TLS_REJECT_UNAUTHORIZED  true   verify the server certificate
 */
export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (SMTPS). When false the connection is upgraded with STARTTLS. */
  secure: boolean;
  auth?: { user: string; pass: string };
  from: string;
  replyTo?: string;
  /** Fail instead of falling back to an unencrypted session. Ignored when `secure`. */
  requireTLS: boolean;
  rejectUnauthorized: boolean;
}

export class SmtpConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid SMTP configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "SmtpConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function bool(value: string | undefined, fallback: boolean, name: string, problems: string[]): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  problems.push(`${name} must be "true" or "false" (got "${value}").`);
  return fallback;
}

/** A header-safe address: no line breaks (header injection), one mailbox. */
export function isSafeMailbox(value: string): boolean {
  return !/[\r\n\u0000]/.test(value) && /^(?:[^<>@]*<)?[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+>?$/.test(value.trim());
}

export function loadSmtpConfig(env: Env = process.env): SmtpConfig {
  const problems: string[] = [];
  const get = (key: string) => env[key]?.trim() || undefined;

  const host = get("UNIORA_SMTP_HOST");
  if (!host) problems.push("UNIORA_SMTP_HOST is required.");
  else if (/[\s/]/.test(host)) problems.push("UNIORA_SMTP_HOST must be a bare host name (no scheme, path or spaces).");

  const portText = get("UNIORA_SMTP_PORT");
  const port = portText === undefined ? 587 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`UNIORA_SMTP_PORT must be an integer between 1 and 65535 (got "${portText}").`);
  }

  const secure = bool(env.UNIORA_SMTP_SECURE, port === 465, "UNIORA_SMTP_SECURE", problems);
  const requireTLS = bool(env.UNIORA_SMTP_REQUIRE_TLS, true, "UNIORA_SMTP_REQUIRE_TLS", problems);
  const rejectUnauthorized = bool(
    env.UNIORA_SMTP_TLS_REJECT_UNAUTHORIZED,
    true,
    "UNIORA_SMTP_TLS_REJECT_UNAUTHORIZED",
    problems,
  );

  const user = get("UNIORA_SMTP_USER");
  const pass = env.UNIORA_SMTP_PASS === undefined || env.UNIORA_SMTP_PASS === "" ? undefined : env.UNIORA_SMTP_PASS;
  if ((user === undefined) !== (pass === undefined)) {
    problems.push("UNIORA_SMTP_USER and UNIORA_SMTP_PASS must be set together (or both left empty).");
  }

  const from = get("UNIORA_SMTP_FROM");
  if (!from) problems.push("UNIORA_SMTP_FROM is required (e.g. \"Acme <no-reply@acme.com>\").");
  else if (!isSafeMailbox(from)) problems.push("UNIORA_SMTP_FROM must be a single valid address, optionally with a display name.");

  const replyTo = get("UNIORA_SMTP_REPLY_TO");
  if (replyTo && !isSafeMailbox(replyTo)) problems.push("UNIORA_SMTP_REPLY_TO must be a single valid address.");

  if (problems.length > 0) throw new SmtpConfigError(problems);

  return {
    host: host!,
    port,
    secure,
    auth: user !== undefined && pass !== undefined ? { user, pass } : undefined,
    from: from!,
    replyTo,
    requireTLS,
    rejectUnauthorized,
  };
}
