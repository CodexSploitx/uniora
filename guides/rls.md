# Row-level security with UNIORA (PostgreSQL)

Your own tables (`vehicles`, `reports`, …) can ask UNIORA — inside the database — who may see or change a row, with the
same answers `engine.can()` and `access.check()` give. The functions ship with `uniora migrate` (Postgres migration `0021`).

| Function | True when |
| --- | --- |
| `uniora.is_member(org)` | the current user has an **active** membership in `org` (a blocked member is not a member) |
| `uniora.has_permission(org, key)` | a role of the user in `org` holds `key`, or the user is the Owner and `key` is well formed |
| `uniora.is_feature_enabled(org, key)` | the feature is on for `org`: its override, else its default, and every parent on |
| `uniora.has_access(org, permission, feature)` | every argument given holds (like `access.check`); with neither, `is_member` |

A **suspended or archived organization** (`organizations.setStatus`) denies everyone in it from `is_member`, `has_permission` and `has_access`, Owner included, exactly like the engine; `is_feature_enabled` still reports the feature's own state.

Anything unknown — an organization, a permission, a feature, a missing identity, a `NULL` — answers `false`; they never raise.

```sql
create policy "members read" on public.vehicles
  for select using (uniora.is_member(organization_id));

create policy "editors update" on public.vehicles
  for update using (uniora.has_permission(organization_id, 'vehicles.update'));

create policy "reports feature" on public.reports
  for select using (uniora.has_access(organization_id, 'reports.read', 'advanced_reports'));
```

## 1. Say who the current user is

`uniora.current_identity()` reads two transaction-local settings. A server that talks to the database as one role sets them
per request, **inside the transaction**:

```sql
select set_config('uniora.identity_provider', 'supabase', true),
       set_config('uniora.identity_subject',  '5b2f…', true);
```

On Supabase, derive it from the verified JWT instead, by replacing that one function (it is the only place that knows your
auth layer):

```sql
create or replace function uniora.current_identity()
returns table (provider text, subject text)
language sql stable
set search_path = pg_catalog, pg_temp
as $$ select 'supabase'::text, auth.uid()::text where auth.uid() is not null $$;
```

> The settings are only as trustworthy as who can run `set_config`: use them from trusted server code, never for a role an
> end user can open a SQL session with (they could name anyone). Prefer the `auth.uid()` form there.

## 2. Grant execute on purpose

`EXECUTE` is revoked from `public`. Grant it to the roles your policies run as; they need **no** access to the `uniora` tables
(the functions are `security definer`, with a pinned `search_path`), only `usage` on the schema:

```sql
grant usage on schema uniora to authenticated;
grant execute on function
  uniora.is_member(text), uniora.has_permission(text, text),
  uniora.is_feature_enabled(text, text), uniora.has_access(text, text, text)
to authenticated;
```

The explicit-identity forms (`is_member(org, provider, subject)`, `has_permission(org, key, provider, subject)`) are for
trusted server code, e.g. a job that checks someone other than the caller. **Don't grant them to end-user roles.**

## 3. Match the engine

- A blocked member is denied everything, Owner included — in the engine and here. A timed suspension (`block(id, { until })`) ends by itself in the SQL functions too: they compare `until` with the database clock, so a policy and `can()` agree before and after the date.
- If you run the engine with `ownerRequiresRegisteredPermission: true`, set the same in the database so a policy and
  `can()` agree: `alter database app set uniora.owner_requires_registered_permission = 'on';`
- Implied permissions (`register({ key, implies })`): `has_permission` also passes when a role holds a permission that implies `key`, through the whole chain, like `can()`.
- Features: policies and `computeAuthorizationSnapshot` use the same rule (override → default → parents).

Re-test your policies with the least-privileged role you use in production; `rls-functions.test.ts` in `@uniora/postgres` does
exactly that against the real engine.
