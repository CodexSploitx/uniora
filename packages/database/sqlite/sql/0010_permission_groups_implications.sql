-- @uniora/sqlite migration 0010_permission_groups_implications
-- Generated from src/migrations/0010_permission_groups_implications.ts; do not edit. Regenerate with `pnpm sql:export`.
--
-- Permission groups and implied permissions — same model as `@uniora/postgres`'s `0025_permission_groups_implications`.
-- `group_key` is the catalog section; `uniora_permission_implications` says which permissions a permission grants as
-- well (`appointments.write` implies `appointments.read`). The implied side is RESTRICTED: a permission another one
-- still implies can't be deleted by accident.

alter table uniora_permissions add column group_key text check (group_key is null or length(group_key) <= 100);
create index if not exists uniora_permissions_group_key_idx on uniora_permissions (group_key, key);

create table if not exists uniora_permission_implications (
  permission_key text not null references uniora_permissions (key) on delete cascade,
  implied_key text not null references uniora_permissions (key) on delete restrict,
  primary key (permission_key, implied_key),
  check (permission_key <> implied_key)
);
create index if not exists uniora_permission_implications_implied_idx on uniora_permission_implications (implied_key);
