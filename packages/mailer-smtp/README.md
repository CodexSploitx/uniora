# @uniora/mailer-smtp

SMTP delivery for [UNIORA](https://github.com/CodexSploitx/uniora) invitations. It implements `InvitationSender` from `@uniora/core`, reads its settings from `UNIORA_SMTP_*` environment variables and ships professional, responsive, dark-mode-aware templates in English, Spanish, Portuguese, French, German and Italian.

```ts
import { createInvitationService } from "@uniora/core";
import { createSmtpInvitationSenderFromEnv } from "@uniora/mailer-smtp";

const sender = createSmtpInvitationSenderFromEnv(process.env, {
  brandName: "Acme",
  brandColor: "#0f766e",
  logoUrl: "https://acme.com/logo.png",
  supportEmail: "help@acme.com",
  resolveInviterName: async (identity) => (await db.users.find(identity.subject))?.name,
});
await sender.verify(); // optional startup check: connects and authenticates

const invitations = createInvitationService({ storage, sender, acceptUrl: (t) => `https://app.acme.com/invite/${t}` });
```

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `UNIORA_SMTP_HOST` | — | **required**, bare host name |
| `UNIORA_SMTP_PORT` | `587` | `465` uses implicit TLS, otherwise STARTTLS |
| `UNIORA_SMTP_SECURE` | `true` only on 465 | force implicit TLS |
| `UNIORA_SMTP_USER` / `UNIORA_SMTP_PASS` | — | both or neither |
| `UNIORA_SMTP_FROM` | — | **required**, `Name <addr>` or `addr` |
| `UNIORA_SMTP_REPLY_TO` | — | optional |
| `UNIORA_SMTP_REQUIRE_TLS` | `true` | refuse to send unencrypted |
| `UNIORA_SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | verify the server certificate |

Anything missing or malformed throws one `SmtpConfigError` listing every problem — at startup, not on the first invitation.

## Behaviour

- **Retries, timeouts and bookkeeping** are done by `createInvitationService`; this package classifies failures: bad credentials and any `5xx`/rejected recipient are permanent (no retry), network errors and `4xx` are transient.
- **Templates are safe by construction**: every interpolated value is escaped, the Subject is forced onto one line, the link must be `http(s)`, the logo `https`, the brand color a `#rrggbb`.
- **Own template?** Pass `template: (message, context) => ({ subject, html, text })`. **Own provider?** Implement `InvitationSender` yourself — nothing else in UNIORA changes.
- Each message carries `Auto-Submitted: auto-generated` and an `X-Entity-Ref-ID` (invitation id + attempt) for correlating provider logs. The token never appears in headers or logs.

Documentation: [Invitations guide](https://github.com/CodexSploitx/uniora/blob/main/guides/invitations.md) and the [full index](https://github.com/CodexSploitx/uniora/blob/main/guides/README.md).
