import { createTransport } from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { InvitationDeliveryError, type Identity, type InvitationMessage, type InvitationSender, type SendContext } from "@uniora/core";
import { loadSmtpConfig, type SmtpConfig } from "./config.js";
import {
  renderInvitationEmail,
  type InvitationTemplate,
  type InvitationTemplateOptions,
} from "./templates.js";

/** The slice of a nodemailer transport the sender uses — lets tests (and other transports) plug in. */
export interface MailTransport {
  sendMail(mail: {
    from: string;
    to: string;
    replyTo?: string;
    subject: string;
    html: string;
    text: string;
    headers?: Record<string, string>;
  }): Promise<unknown>;
  verify?(): Promise<unknown>;
  close?(): void;
}

export interface SmtpInvitationSenderOptions extends InvitationTemplateOptions {
  /** Defaults to `loadSmtpConfig(process.env)` — i.e. the `UNIORA_SMTP_*` variables. */
  config?: SmtpConfig;
  /** Bring your own transport (tests, a different nodemailer setup). When set, `config` is only used for From/Reply-To. */
  transport?: MailTransport;
  /** Full control of subject, HTML and text. Defaults to `renderInvitationEmail`. */
  template?: InvitationTemplate;
  /** Turns the inviter's identity into a display name for the e-mail, e.g. a lookup in your user table. */
  resolveInviterName?: (identity: Identity) => Promise<string | undefined> | string | undefined;
  /** Connection pooling for the built-in transport. Default `true`. */
  pool?: boolean;
}

export interface SmtpInvitationSender extends InvitationSender {
  /** Opens a connection and authenticates, without sending anything. Use at startup or in a health check. */
  verify(): Promise<void>;
  /** Closes pooled connections. */
  close(): void;
}

interface SmtpLikeError {
  code?: unknown;
  responseCode?: unknown;
  command?: unknown;
  message?: unknown;
}

/**
 * Failures a retry can't fix: bad credentials, a rejected sender/recipient or
 * any 5xx reply. Network trouble, timeouts and 4xx (greylisting, throttling,
 * mailbox busy) are transient and worth another attempt.
 */
export function isPermanentSmtpFailure(error: unknown): boolean {
  const { code, responseCode } = (error ?? {}) as SmtpLikeError;
  if (code === "EAUTH") return true;
  if (typeof responseCode === "number") return responseCode >= 500 && responseCode < 600;
  return code === "EENVELOPE" || code === "EMESSAGE";
}

function toDeliveryError(error: unknown): InvitationDeliveryError {
  const { code, responseCode, message } = (error ?? {}) as SmtpLikeError;
  const detail = [typeof code === "string" ? code : undefined, typeof responseCode === "number" ? String(responseCode) : undefined]
    .filter(Boolean)
    .join(" ");
  const text = `SMTP delivery failed${detail ? ` (${detail})` : ""}: ${typeof message === "string" ? message : String(error)}`;
  return new InvitationDeliveryError(text, isPermanentSmtpFailure(error), { cause: error });
}

function buildTransport(config: SmtpConfig, pool: boolean): MailTransport {
  const smtp: SMTPTransport.Options = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && config.requireTLS,
    auth: config.auth,
    tls: { rejectUnauthorized: config.rejectUnauthorized, minVersion: "TLSv1.2" },
    // Below the delivery engine's per-attempt budget, so a dead server fails
    // here with a real error instead of by an abandoned promise.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
  const transporter = pool
    ? createTransport({ ...smtp, pool: true, maxConnections: 3 } satisfies SMTPPool.Options)
    : createTransport(smtp);
  return transporter as unknown as MailTransport;
}

/**
 * The SMTP implementation of `InvitationSender`. Plug it into
 * `createInvitationService({ sender })`; retries, timeouts and delivery
 * bookkeeping are the service's job, so this only has to render, send and
 * classify failures correctly.
 */
export function createSmtpInvitationSender(options: SmtpInvitationSenderOptions = {}): SmtpInvitationSender {
  const config = options.config ?? loadSmtpConfig();
  const template = options.template ?? renderInvitationEmail;

  const transport: MailTransport = options.transport ?? buildTransport(config, options.pool ?? true);

  return {
    async send(message: InvitationMessage, context: SendContext): Promise<void> {
      let inviterName: string | undefined;
      try {
        inviterName = await options.resolveInviterName?.(message.invitedBy);
      } catch {
        inviterName = undefined; // a failed name lookup must never block the invitation
      }

      const rendered = await template(message, {
        brandName: options.brandName,
        brandColor: options.brandColor,
        logoUrl: options.logoUrl,
        supportEmail: options.supportEmail,
        defaultLocale: options.defaultLocale,
        inviterName,
      });

      try {
        await transport.sendMail({
          from: config.from,
          to: message.to,
          replyTo: config.replyTo,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          headers: {
            // Machine-generated transactional mail: keeps auto-responders quiet.
            "Auto-Submitted": "auto-generated",
            "X-Auto-Response-Suppress": "All",
            // Correlates provider logs with the invitation without exposing the token.
            "X-Entity-Ref-ID": `${message.invitationId}.${context.attempt}`,
          },
        });
      } catch (error) {
        throw toDeliveryError(error);
      }
    },

    async verify() {
      if (!transport.verify) return;
      try {
        await transport.verify();
      } catch (error) {
        throw toDeliveryError(error);
      }
    },

    close() {
      transport.close?.();
    },
  };
}

/** `createSmtpInvitationSender` configured entirely from `UNIORA_SMTP_*`; throws `SmtpConfigError` listing everything missing. */
export function createSmtpInvitationSenderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Omit<SmtpInvitationSenderOptions, "config"> = {},
): SmtpInvitationSender {
  return createSmtpInvitationSender({ ...options, config: loadSmtpConfig(env) });
}
