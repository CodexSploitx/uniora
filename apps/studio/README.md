# @uniora/studio

UNIORA Studio: a local-first admin UI over your own database. Browse and manage organizations, members, roles, permissions, features, **invitations** and the append-only activity log. It listens only on `127.0.0.1`, is unlocked by a random per-launch token, and sends data nowhere. Every change it makes is audited, and `--read-only` makes it a safe viewer.

Launch it with the CLI (it is not meant to be run directly):

```bash
npx uniora studio            # --read-only, --port N, --no-open
```

## Invitations

The **Invitations** tab of an organization lists invitations (status, roles, expiry, delivery) and lets an operator invite, send again and revoke.

| Variable | |
| --- | --- |
| `UNIORA_INVITE_URL` | **Required to invite.** The page of your app that accepts invitations, with `{token}` where the secret goes, e.g. `https://app.example.com/invite/{token}`. The token must be in the path or fragment, not the query string. |
| `UNIORA_SMTP_*` | Optional. With `@uniora/mailer-smtp` installed, invitations are e-mailed. Without it, Studio shows the link once for you to share. |

Set them in your `.env`; the CLI passes the environment to Studio.

Studio is an operator tool: run it on your own machine or behind your own access control, never exposed to the internet.

License: [PolyForm Shield 1.0.0](https://github.com/CodexSploitx/uniora/blob/main/LICENSE).
