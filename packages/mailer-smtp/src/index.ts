export type { SmtpConfig } from "./config.js";
export { isSafeMailbox, loadSmtpConfig, SmtpConfigError } from "./config.js";

export type { EmailLocale, InvitationStrings } from "./locales.js";
export { DEFAULT_LOCALE, resolveLocale, STRINGS } from "./locales.js";

export type {
  InvitationTemplate,
  InvitationTemplateContext,
  InvitationTemplateOptions,
  RenderedEmail,
} from "./templates.js";
export { escapeHtml, renderInvitationEmail } from "./templates.js";

export type { MailTransport, SmtpInvitationSender, SmtpInvitationSenderOptions } from "./sender.js";
export { createSmtpInvitationSender, createSmtpInvitationSenderFromEnv, isPermanentSmtpFailure } from "./sender.js";
