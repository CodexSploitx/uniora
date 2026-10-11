# Invitations

UNIORA owns the whole flow: a single-use token (only its SHA-256 is stored), the roles to grant, expiry, resend, revoke, accept, rate limits
and an audit trail. Delivery is pluggable: you provide an `InvitationSender`, or use [`@uniora/mailer-smtp`](#sending-e-mail-with-smtp).

```text
invite() ──> token + link ──> sender delivers e-mail ──> person opens link ──> preview() ──> signs in ──> accept() ──> membership
```

## Create the service

```ts
import { createInvitationService } from "@uniora/core";
import { createSmtpInvitationSenderFromEnv } from "@uniora/mailer-smtp";

const invitations = createInvitationService({
  storage,
  acceptUrl: (token) => `https://app.example.com/invite/${token}`, // token in the PATH or fragment, never the query string
  sender: createSmtpInvitationSenderFromEnv(),                      // optional
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `storage` | required | Where invitations, memberships and the audit log live. |
| `acceptUrl(token)` | required | Builds the link for the person. |
| `sender` | none | Delivers the message. Without one the invitation is still created and you get the link back to deliver yourself. |
| `ttlMs` | 7 days | Lifetime of a link (maximum 30 days). `invite({ …, ttlMs })` and `resend(ref, { ttlMs })` override it for one invitation (e.g. 24 hours); `resend` without it uses the service default. |
| `rateLimits` | see below | `perEmailPerHour` 5, `perEmailGlobalPerHour` 50, `perOrganizationPerHour` 200, `resendCooldownMs` 60 000. |
| `retry` | 3 attempts | `{ maxAttempts, baseDelayMs, maxDelayMs, attemptTimeoutMs }`: jittered backoff and a time budget per attempt. |
| `now`, `generateId`, `sleep`, `random` | real ones | Injection points for tests. |

## Invite, resend, revoke

**By default the service does not authorize the caller.** Check your own permission first (we suggest `members.invite`). Over a storage wrapped by
`createGuardedStorage` (or with `access: true`) it does: the inviter needs `members.invite` and every permission of the roles they offer, and `accept`
re-checks what the inviter can still give. See [Delegated administration](access-admin.md#invitations).

```ts
if (!(await engine.can({ identity: actor, organizationId, permission: "members.invite" }))) throw forbidden();

const { invitation, acceptUrl, delivery } = await invitations.invite({
  organizationId,
  email: "ana@example.com",
  roleIds: [editorRoleId],  // 1 to 25 regular roles of THIS organization; never the Owner role
  invitedBy: actor,
  locale: "es",             // language of the e-mail (en, es, pt, fr, de, it)
});
// delivery: { status: "sent" | "failed" | "skipped", attempts, error? }

await invitations.resend({ organizationId, invitationId: invitation.id, actor }); // new token, the old link stops working
await invitations.revoke({ organizationId, invitationId: invitation.id, actor });
```

- E-mails are normalized (trimmed, lower-cased) and validated. A second pending invitation to the same address in the same organization is refused (`invitation_duplicate_pending`).
- **A mail failure never fails `invite()`.** The outcome is stored on the invitation (`invitation.delivery`) and recorded in the audit log as `invitation.delivery_failed`; call `resend` to try again.
- `resend` and `revoke` treat another organization's invitation as missing.
- Hitting a rate limit raises `invitation_rate_limited` (or `invitation_cooldown` for a quick resend).
- List them for a screen with `storage.invitations.search(organizationId, { status?, query?, limit?, after? })`: `query` is a case-insensitive part of the invited e-mail (`%` and `_` are matched literally), newest first with a keyset cursor. `storage.invitations.count(organizationId, { status?, query? })` returns the total for the same filters, for a "42 invitations" header or page count.
- **Already a member?** UNIORA stores no e-mail on memberships, so it can't know on its own. Give the service a lookup and `invite()` refuses an address that belongs to a member with `invitation_already_member` (HTTP 409 through `invitationErrorToHttp`), instead of leaving the discovery for accept time:

  ```ts
  createInvitationService({
    storage,
    acceptUrl,
    // your auth provider: which identities own this normalized address? `[]` when none.
    findIdentitiesByEmail: async (email) => (await findUsersByEmail(email)).map((u) => ({ provider: "supabase", subject: u.id })),
  });
  ```

  Pass `allowExistingMember: true` to `invite()` to deliberately invite a member anyway (accepting then adds the invited roles). Without the lookup nothing changes.

- **Teams (`teamIds`).** An invitation can also offer membership of up to 10 teams of the organization (see [teams](teams.md)): `invite({ organizationId, email, roleIds, invitedBy, teamIds: ["team-barcelona"] })`. The inviter needs `teams.members.add` (organization-wide, or inside that team) now **and** when the person accepts; if they lost it, or the team was archived or deleted, or the person already has a membership there (a suspension is never lifted this way), that team is skipped and listed in `accept().teamsSkipped` while the organization membership still happens. Joined teams come back in `accept().teams`, always as plain `member` with no team role: assign roles afterwards with the team service. `preview()` lists `teamNames`.

- **Safe retries (`idempotencyKey`).** A network timeout leaves you not knowing whether `invite()` worked, and a plain retry fails with `invitation_duplicate_pending` while the link of the first call is lost. Pass a key of your own per attempt-to-invite (for example the id of the request or form submission):

  ```ts
  const result = await invitations.invite({ organizationId, email, roleIds, invitedBy, idempotencyKey: requestId });
  if (result.replayed) {
    // The invitation already existed: nothing was created or sent, and there is no link (`result.acceptUrl` is `null`).
    // Use `invitations.resend(...)` if the person needs a new link.
  }
  ```

  The same key with the same request (e-mail, roles, `ttlMs`) returns the existing invitation with `replayed: true`; the same key with a different request fails with `invitation_idempotency_conflict` (HTTP 409 `idempotency_conflict`). Keys are scoped to the organization, are 1 to 128 characters of letters, digits and `._:-`, and live as long as the invitation. Without a key nothing changes.

## Preview and accept

```ts
const preview = await invitations.preview(token);
// { organizationName, email, roleNames, expiresAt } or null. Show it on the landing page.

const { membership, alreadyMember } = await invitations.accept({
  token,
  identity,                         // who is signed in (from your adapter)
  verifiedEmail: toVerifiedEmail(user), // the e-mail your PROVIDER verified, never a form field
});
```

`accept` succeeds only when the token is valid and unused, not expired or revoked, **and** `verifiedEmail` equals the invited address. It grants exactly the
roles on the invitation and records who invited the member. Every failure (unknown, expired, revoked, used, wrong e-mail) throws the **same generic** error,
so the endpoint can't be used to find out which links or addresses exist. `alreadyMember` is `true` when the person was already in the organization.

## Routes

Ready-made handlers answer: preview `200 { organizationName, email, roleNames, expiresAt }`, or `404 { "error": "invalid_invitation" }` for any invalid link; accept `200 { organizationId, membershipId, alreadyMember }`,
`401 { "error": "unauthenticated" }` when no caller is resolved, or `400 { "error": "invalid_invitation" }` for every way an accept can fail. Any other error goes to `next(err)` (Express) or is rethrown (Next.js).

**Express**

```ts
import { acceptInvitation, invitationPreview } from "@uniora/express";

app.get("/invite/:token", invitationPreview(invitations, { token: (req) => req.params.token }));
app.post("/invite/:token/accept", acceptInvitation(invitations, {
  token: (req) => req.params.token,
  resolve: async (req) => req.user && { identity: req.identity, verifiedEmail: req.user.verifiedEmail },
}));
```

**Next.js Route Handlers**

```ts
import { acceptInvitationRoute, previewInvitationRoute } from "@uniora/next";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  return previewInvitationRoute(invitations, (await params).token);
}
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const caller = await currentCaller(); // { identity, verifiedEmail } or null
  return acceptInvitationRoute(invitations, { token: (await params).token, caller });
}
```

Other frameworks: call `invitations.accept` yourself and translate errors with `invitationErrorToHttp(error)` (`null` when it isn't an invitation error).

## Sending e-mail with SMTP

```bash
npm install @uniora/mailer-smtp
```

```ini
# .env
UNIORA_SMTP_HOST=smtp.example.com
UNIORA_SMTP_PORT=587
UNIORA_SMTP_USER=…
UNIORA_SMTP_PASS=…
UNIORA_SMTP_FROM="Acme <no-reply@acme.com>"
```

```ts
import { createSmtpInvitationSenderFromEnv } from "@uniora/mailer-smtp";

const sender = createSmtpInvitationSenderFromEnv(process.env, {
  brandName: "Acme",
  brandColor: "#0f766e",                      // #rrggbb
  logoUrl: "https://acme.com/logo.png",       // https only
  supportEmail: "help@acme.com",
  resolveInviterName: async (identity) => (await users.find(identity.subject))?.name,
});
await sender.verify(); // optional startup check: connects and authenticates
```

| Variable | Default | |
| --- | --- | --- |
| `UNIORA_SMTP_HOST` | none | required, a bare host name |
| `UNIORA_SMTP_PORT` | `587` | `465` uses implicit TLS, anything else STARTTLS |
| `UNIORA_SMTP_SECURE` | `true` only on 465 | force implicit TLS |
| `UNIORA_SMTP_USER` / `UNIORA_SMTP_PASS` | none | both or neither |
| `UNIORA_SMTP_FROM` | none | required: `Name <addr>` or `addr` |
| `UNIORA_SMTP_REPLY_TO` | none | optional |
| `UNIORA_SMTP_REQUIRE_TLS` | `true` | refuses to send unencrypted |
| `UNIORA_SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | verifies the server certificate |

Missing or malformed values throw one `SmtpConfigError` listing every problem, **at startup**. `npx uniora doctor` runs the same validation without connecting.
Authentication failures and `5xx`/rejected recipients are permanent (no retry); network errors and `4xx` are retried.

Templates are safe by construction (every value escaped, one-line subject, `http(s)` link only) and come in en, es, pt, fr, de and it with a dark-mode-aware layout.
Use your own with `template: (message, context) => ({ subject, html, text })`, or `renderInvitationEmail` to start from the built-in one.
Messages carry `Auto-Submitted: auto-generated` and an `X-Entity-Ref-ID`; the token never appears in headers or logs.

### Writing your own sender (Resend, SES, a queue…)

```ts
import { InvitationDeliveryError, type InvitationSender } from "@uniora/core";

const sender: InvitationSender = {
  async send(message, { signal, attempt }) {
    // message: { invitationId, to, organization: { id, name, slug }, roleNames, invitedBy, acceptUrl, expiresAt, locale? }
    const { error } = await resend.emails.send(
      { to: message.to, subject: `Join ${message.organization.name}`, html: render(message) },
      { signal },
    );
    if (error) throw new InvitationDeliveryError(error.message, /* permanent */ error.statusCode === 422);
  },
};
```

- Throw to signal failure. `new InvitationDeliveryError(message, true)` marks it **permanent** (rejected recipient, bad credentials) so it isn't retried; anything else is retried.
- `signal` aborts when the attempt exceeds its time budget: pass it to your HTTP client.
- Make `send` safe to call twice for the same `invitationId` (a timeout may have delivered the first one).
- `message.acceptUrl` holds the secret token. Never log it. UNIORA scrubs links and tokens from the error text it stores.
- Retries (`retry` option): `maxAttempts` 3, `baseDelayMs` 500 (doubles, full jitter), `maxDelayMs`, `attemptTimeoutMs` 15 s.

## Studio

Studio's **Invitations** tab lists invitations and lets an operator invite, resend and revoke. Set `UNIORA_INVITE_URL` (for example
`https://app.example.com/invite/{token}`, with `{token}` in the path or fragment). With `@uniora/mailer-smtp` installed and `UNIORA_SMTP_*` set it e-mails; otherwise it shows the link once.
