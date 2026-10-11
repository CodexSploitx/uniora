# Roadmap

What UNIORA does not do yet, and why. Nothing here is promised; it is the list we would pick from.

## Next

- **Delete an organization.** Not implemented on purpose. Audit entries reference their organization and are append-only, so deleting one needs a decision first: keep the audit trail with the organization anonymized, or soft-delete (archive) the organization. We lean towards archiving. Until then, remove access by removing members.
- **Resend and revoke from the CLI** and a `uniora invitations` command for scripting.
- **Batch checks.** `engine.canAll(identity, organizationId, keys)` and a "what can this user do here" listing, so a UI can render in one round trip instead of one `can` per button.

## Later

- **Server: delegated reads** of members, roles and teams (deny by default: the actor must hold a read permission). Policies can already be read as an end user; everything else is read by the application.
- **Server: a published container image** (non-root, read-only filesystem, health check) and OpenTelemetry metrics.

- **Resource-level permissions** ("edit *this* project"): a `resource` argument to `can`, with grants stored per resource. Today, model it with one role per resource or check ownership in your own code after `can`.
- **Role inheritance and role templates**: a role that includes another, and templates copied into each new organization.
- **Per-organization policies** (for example "members must verify e-mail", invitation lifetime) instead of one global option set.
- Storage adapters beyond PostgreSQL and SQLite (the conformance suite is the contract).

## Out of scope

- Authentication. UNIORA answers "what can this identity do", never "who is this": that stays with your auth provider.
- A hosted service. Your data stays in your database.
