# Row-level security with UNIORA (PostgreSQL)

Your own tables (`vehicles`, `reports`, …) can ask UNIORA — inside the database — who may see or change a row, with the
same answers `engine.can()` and `access.check()` give. The functions ship with `uniora migrate` (Postgres migration `0021`; the team functions of [§5](#5-policies-by-team) come with migration `0048`).

| Function | True when |
| --- | --- |
| `uniora.is_member(org)` | the current user has an **active** membership in `org` (a blocked member is not a member) |
| `uniora.has_permission(org, key)` | a role of the user in `org` holds `key`, or the user is the Owner and `key` is well formed |
| `uniora.is_feature_enabled(org, key)` | the feature is on for `org`: its override, else its default, and every parent on |
| `uniora.has_access(org, permission, feature)` | every argument given holds (like `access.check`); with neither, `is_member` |
| `uniora.is_team_member(org, team)` | the current user is an **active** member of the **active** team `team` of `org` (what the engine reads as `subject.teamIds`) — [policies by team](#5-policies-by-team) |
| `uniora.is_team_manager(org, team)` | the same, and the person is the team's `owner` or `manager` (what the engine reads as `subject.managedTeamIds`) |

A **suspended or archived organization** (`organizations.setStatus`) denies everyone in it from `is_member`, `has_permission` and `has_access`, Owner included, exactly like the engine; `is_feature_enabled` still reports the feature's own state.

Anything unknown — an organization, a permission, a feature, a missing identity, a `NULL` — answers `false`; they never raise.

> **A policy only protects you from roles that are subject to it.** PostgreSQL does not apply row-level security to the
> **owner of the table** (nor to a superuser or a role with `BYPASSRLS`), and it does so silently: no error, no warning.
> If one role migrates your tables and also serves the application, every policy below is off. Read
> [§4](#4-the-table-owner-skips-the-policies) before relying on them.

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
  uniora.is_feature_enabled(text, text), uniora.has_access(text, text, text),
  uniora.is_team_member(text, text), uniora.is_team_manager(text, text)
to authenticated;
```

The explicit-identity forms (`is_member(org, provider, subject)`, `has_permission(org, key, provider, subject)`, `is_team_member(org, team, provider, subject)`, `is_team_manager(org, team, provider, subject)`) are for
trusted server code, e.g. a job that checks someone other than the caller. **Don't grant them to end-user roles.**

## 3. Match the engine

- A blocked member is denied everything, Owner included — in the engine and here. A suspension (`suspend(id, { until })`) ends by itself in the SQL functions too: they compare `until` with the database clock, so a policy and `can()` agree before and after the date.
- If you run the engine with `ownerRequiresRegisteredPermission: true`, set the same in the database so a policy and
  `can()` agree: `alter database app set uniora.owner_requires_registered_permission = 'on';`
- Implied permissions (`register({ key, implies })`): `has_permission` also passes when a role holds a permission that implies `key`, through the whole chain, like `can()`.
- Features: policies and `computeAuthorizationSnapshot` use the same rule (override → default → parents).

## 4. The table owner skips the policies

This is standard PostgreSQL, not a UNIORA behavior, but it is the easiest way to end up with policies that do nothing.
Row-level security is **not applied** to:

- the **owner of the table** (the role that ran `create table`, or that you gave it to with `alter table … owner to`),
  unless the table has `FORCE ROW LEVEL SECURITY`;
- a **superuser** and any role with the **`BYPASSRLS`** attribute, always — `FORCE` does not stop them (on Supabase, the
  `postgres` role has it).

Seen against PostgreSQL 17 with a table protected by `uniora.is_member(organization_id)` and two rows in two organizations:

| Connected as | Identity set | Rows read |
| --- | --- | --- |
| the table owner | none | 2 of 2 — no policy applied |
| the table owner, after `FORCE ROW LEVEL SECURITY` | none | 0 |
| an application role that does not own the table | a member of one organization | 1 of 2 |
| an application role that does not own the table | none | 0 |

Do both of these:

1. **Serve the application with a role that does not own the tables and has neither `SUPERUSER` nor `BYPASSRLS`.**
   Migrate with another role. This is the same split as [Hardening §5](hardening.md) and
   [`least-privilege-roles.sql`](sql/least-privilege-roles.sql): one role owns and migrates, the other only reads and writes.
2. **Add `FORCE ROW LEVEL SECURITY` to every table that has policies**, so that a mistake in (1) — a small installation that
   uses one role for everything, a connection string copied from the wrong place — does not switch them off:

```sql
alter table public.vehicles enable row level security;
alter table public.vehicles force  row level security;
```

`FORCE` also applies the policies to the owner when it runs your own migrations and seeds: it will see only the rows a
policy lets it see, and its `insert`s and `update`s must pass `with check`. Run data migrations that must touch every row as a
role with `BYPASSRLS` (and keep that role out of the application), or add a policy for them.

`npx uniora doctor` warns when the role it connects with owns tables that have RLS and no `FORCE`, or has `SUPERUSER` /
`BYPASSRLS`. Run it with the application's `DATABASE_URL` to check the role that matters; it reads only the catalog.

Test it the way production runs it: connect **as the application role**, set the identity (§1) and check the rows you get
for a member, for a person of another organization and for no identity at all. If you want a guard, add a test that also
connects as the table owner and asserts it still sees no foreign rows once `FORCE` is on.

## 5. Policies by team

`uniora.is_team_member(org, team)` and `uniora.is_team_manager(org, team)` give your own tables a second layer for "only the people of this row's team": they answer in the database what the engine reads as `subject.teamIds` and `subject.managedTeamIds` for the [team policies](policies.md) (`kind: "scope"`). They need migration `0048` (`uniora migrate`, or apply `packages/database/postgres/sql/0048_rls_team_functions.sql`), and EXECUTE granted as in [§2](#2-grant-execute-on-purpose).

```sql
-- every active member of the row's team reads it
create policy "team reads" on public.documents
  for select using (uniora.is_team_member(organization_id, team_id));

-- only the people who lead the row's team (owner or manager) read it
create policy "team leads read" on public.payroll
  for select using (uniora.is_team_manager(organization_id, team_id));
```

- **Store UNIORA's team id.** `team_id` must hold the `id` of the team in UNIORA, not its slug or your own external id. Which team a row belongs to is your data; UNIORA only answers whether the person belongs to that team.
- **`uuid` columns need a cast.** The arguments are `text`. UNIORA's own ids are strings (and by default random UUIDs), so a `uuid` column is natural, but PostgreSQL does not convert it on its own: write `uniora.is_team_member(organization_id::text, team_id::text)`. Without the cast the policy is refused when you create it (`function uniora.is_team_member(uuid, uuid) does not exist`), so you find out at once; the same applies to `is_member`.
- **Rows of several teams, rows of none.** The functions answer for one team at a time. When a row belongs to a list of teams (`team_ids text[]`, like the engine's `resource.teamIds`), ask for each one: the row is visible if **any** of them is yours.

  ```sql
  create policy "any of the row's teams" on public.documents
    for select using (exists (
      select 1 from unnest(team_ids) as t(id) where uniora.is_team_member(organization_id, t.id)));
  ```

  A row **without a team** (`team_id` is `NULL`, or `team_ids` is empty or `NULL`) is visible to nobody, the organization's Owner included — the same as a resource with `teamIds: []` in the engine, where nothing intersects. If those rows should be visible to the members of the organization, say so in your policy (for example with `uniora.is_member(organization_id)`); it is a decision about your data.
- **Do not create your own functions in the `uniora` schema.** If you already have a `uniora.is_team_member` or `uniora.is_team_manager` of your own (before upgrading, for example), drop or rename it before running the migration. With other parameter names or another return type `uniora migrate` stops (`cannot change name of input parameter`, `cannot change return type of existing function`); with the same name and the same types, the migration replaces yours with UNIORA's without a warning. Keep your own functions in your own schema.
- **What counts, exactly as in the engine.** An **active** member of an **active** team, who is also a current member of the organization: a pending, suspended or removed team member, an archived team, a blocked or suspended member (until the date ends) and a suspended or archived organization all answer `false`, like [`is_member`](#3-match-the-engine). An identity alias answers like the identity it links to. Being a team owner or manager only matters here; it grants no permission by itself (see [Team as context for `can`](teams.md#team-as-context-for-can)).
- **Anything unknown is `false`, never an error:** a team that does not exist or belongs to another organization, an empty or `NULL` argument, no current identity.
- **The engine and the database agree**, with one deliberate difference: the engine stops reading `subject.teamIds` for a person in more than 500 active teams (`MAX_SUBJECT_TEAMS`) and then refuses, "never a guess". The SQL functions ask about one team and answer exactly, so for that person they can say `true` where the engine refuses. The database is the second layer; the application still decides first.
- **Not covered yet:** the team hierarchy (a leader of a parent team seeing the rows of its sub-teams, the engine's `resource.teamPathIds`) and the roles a person holds inside a team. The hierarchy is on the [roadmap](roadmap.md); until then keep those rules in the application with `engine.authorize()`.
- **Cost.** Each row the policy evaluates calls the function, as with `is_member`: index the columns you filter on (`organization_id`, `team_id`) and measure with your own data.
- The explicit-identity forms are for trusted server code only; do not grant them to roles an end user controls (§2).

Re-test your policies with the least-privileged role you use in production; `rls-functions.test.ts` in `@uniora/postgres` does
exactly that against the real engine.
