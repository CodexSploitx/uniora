# Roadmap

What UNIORA does not do yet, and why. Nothing here is promised; it is the list we would pick from.

## Next

- **A standalone API server (`@uniora/server`)**: UNIORA as its own self-hosted service that your backend reaches over HTTP with an API key, with keys managed from Studio. Design under review: [`design/0001-uniora-server.md`](../design/0001-uniora-server.md).
- **Delete an organization.** Not implemented on purpose. Audit entries reference their organization and are append-only, so deleting one needs a decision first: keep the audit trail with the organization anonymized, or soft-delete (archive) the organization. We lean towards archiving. Until then, remove access by removing members.
- **Resend and revoke from the CLI** and a `uniora invitations` command for scripting.
- **Batch checks.** `engine.canAll(identity, organizationId, keys)` and a "what can this user do here" listing, so a UI can render in one round trip instead of one `can` per button.

## Later

- **OAuth 2.0 client credentials for the API server (JWT access tokens).** The first server ships opaque API keys only. The next step is short-lived JWT access tokens (RFC 9068), issued by the server or by the customer's own identity provider and verified with the algorithm, issuer and audience pinned. Design: [`design/0001-uniora-server.md`](../design/0001-uniora-server.md) §5.
- **Verified end-user tokens in the API server.** The API contract already has a header for the end user's JWT (`Uniora-Actor-Token`), and v1 answers `501 actor_token_unsupported` to it. Once verified, a leaked key can no longer speak for an arbitrary user. Design §6.
- **Resource-level permissions** ("edit *this* project"): a `resource` argument to `can`, with grants stored per resource. Today, model it with one role per resource or check ownership in your own code after `can`.
- **Role inheritance and role templates**: a role that includes another, and templates copied into each new organization.
- **Per-organization policies** (for example "members must verify e-mail", invitation lifetime) instead of one global option set.
- **Webhooks or an event stream** for the audit log, so other systems can react to `membership.*` and `invitation.*`.
- Storage adapters beyond PostgreSQL and SQLite (the conformance suite is the contract).

## Out of scope

- Authentication. UNIORA answers "what can this identity do", never "who is this": that stays with your auth provider.
- A hosted service. Your data stays in your database.
