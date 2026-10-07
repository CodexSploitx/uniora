import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthorizationEngine } from "@uniora/core";
import type { Identity, UnioraStorage } from "@uniora/core";
import { applyMigrations } from "./migrate.js";
import { createPostgresStorage } from "./storage.js";

/** Base de datos PROPIA (ver migrate.test.ts): estos tests crean un rol sin privilegios y sembrar datos. */
const DATABASE_NAME = "uniora_test_rls";
const PROBE_ROLE = "uniora_rls_probe";

function urlFor(database: string): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL no está definida (ver .env.example).");
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function ensureDatabase(): Promise<void> {
  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  try {
    const existing = await admin.query("select 1 from pg_database where datname = $1", [DATABASE_NAME]);
    if (existing.rowCount === 0) {
      for (let attempt = 0; ; attempt++) {
        try {
          await admin.query(`create database "${DATABASE_NAME}"`);
          break;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "42P04" || code === "23505") break;
          if (code === "55006" && attempt < 6) {
            await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
            continue;
          }
          throw error;
        }
      }
    }
    // Cluster-level role, created once; NOLOGIN and no table privileges: the whole point of the test.
    const role = await admin.query("select 1 from pg_roles where rolname = $1", [PROBE_ROLE]);
    if (role.rowCount === 0) {
      try {
        await admin.query(`create role ${PROBE_ROLE} nologin nosuperuser nocreaterole nocreatedb`);
      } catch (error) {
        if ((error as { code?: string }).code !== "42710") throw error; // another test file won the race
      }
    }
  } finally {
    await admin.end();
  }
}

const owner: Identity = { provider: "supabase", subject: "owner" };
const staff: Identity = { provider: "supabase", subject: "staff" };
const blocked: Identity = { provider: "supabase", subject: "blocked" };
const other: Identity = { provider: "supabase", subject: "other-org" };
const alias: Identity = { provider: "clerk", subject: "staff-alias" };
const stranger: Identity = { provider: "supabase", subject: "stranger" };
const manager: Identity = { provider: "supabase", subject: "manager" };
const identities = [owner, staff, blocked, other, alias, stranger, manager];
const orgs = ["org-1", "org-2", "org-ghost"];
const permissions = ["vehicles.read", "vehicles.write", "vehicles.manage", "vehicles.super", "reports.read", "never_registered.thing", "Not Valid", ""];
const features = ["agenda", "agenda_chat", "agenda_files", "reports", "ghost", ""];

describe("uniora.* functions for row-level security", () => {
  let pool: Pool;
  let storage: UnioraStorage;

  beforeAll(async () => {
    await ensureDatabase();
    pool = new Pool({ connectionString: urlFor(DATABASE_NAME) });
    await applyMigrations(pool);
    await pool.query("grant usage on schema uniora to " + PROBE_ROLE);
    for (const fn of [
      "uniora.is_member(text)",
      "uniora.is_member(text, text, text)",
      "uniora.has_permission(text, text)",
      "uniora.has_permission(text, text, text, text)",
      "uniora.is_feature_enabled(text, text)",
      "uniora.has_access(text, text, text)",
    ]) {
      await pool.query(`grant execute on function ${fn} to ${PROBE_ROLE}`);
    }

    await pool.query("truncate uniora.organizations cascade");
    await pool.query("truncate uniora.permissions, uniora.feature_definitions cascade");
    storage = createPostgresStorage(pool);
    await storage.organizations.create({ id: "org-1", name: "Uno" });
    await storage.organizations.create({ id: "org-2", name: "Dos" });
    for (const key of ["vehicles.read", "vehicles.write", "reports.read"]) await storage.permissions.register({ key });
    // Implied permissions: super -> manage -> write. The SQL functions must follow the chain exactly like the engine.
    await storage.permissions.register({ key: "vehicles.manage", implies: ["vehicles.write"] });
    await storage.permissions.register({ key: "vehicles.super", implies: ["vehicles.manage"] });

    const ownerRole = await storage.roles.createOwnerRole({ id: "owner-1", organizationId: "org-1" });
    const staffRole = await storage.roles.create({ id: "staff-1", organizationId: "org-1", name: "Staff", permissionKeys: ["vehicles.read", "reports.read"] });
    await storage.roles.create({ id: "staff-2", organizationId: "org-2", name: "Staff", permissionKeys: ["vehicles.write"] });
    const ownerMembership = await storage.memberships.create({ id: "m-owner", organizationId: "org-1", identity: owner });
    await storage.memberships.assignOwnerRole(ownerMembership.id, ownerRole.id);
    await storage.memberships.create({ id: "m-staff", organizationId: "org-1", identity: staff, roleIds: [staffRole.id] });
    await storage.roles.create({ id: "manager-1", organizationId: "org-1", name: "Manager", permissionKeys: ["vehicles.super"] });
    await storage.memberships.create({ id: "m-manager", organizationId: "org-1", identity: manager, roleIds: ["manager-1"] });
    await storage.memberships.create({ id: "m-blocked", organizationId: "org-1", identity: blocked, roleIds: [staffRole.id] });
    await storage.memberships.block("m-blocked", { actor: owner, reason: "test" });
    await storage.memberships.create({ id: "m-other", organizationId: "org-2", identity: other, roleIds: ["staff-2"] });
    await storage.identityLinks.link({ from: alias, to: staff, actor: owner });

    await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
    await storage.features.register({ key: "agenda_chat", name: "Chat", defaultEnabled: true, parentKey: "agenda" });
    await storage.features.register({ key: "agenda_files", name: "Files", parentKey: "agenda" });
    await storage.features.register({ key: "reports", name: "Reports" });
    await storage.features.enable("org-1", "reports");
    await storage.features.enable("org-1", "agenda_files");
    await storage.features.disable("org-2", "agenda");
    await storage.features.enable("org-2", "agenda_files");
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  /** Runs `sql` as the unprivileged probe role, with the "current user" set the way a server would. */
  async function asProbe<T = unknown>(identity: Identity | undefined, sql: string, params: unknown[] = []): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${PROBE_ROLE}`);
      if (identity) {
        await client.query("select set_config('uniora.identity_provider', $1, true), set_config('uniora.identity_subject', $2, true)", [identity.provider, identity.subject]);
      }
      const result = await client.query(sql, params);
      return result.rows[0].v as T;
    } finally {
      await client.query("rollback");
      client.release();
    }
  }

  it("el rol sin privilegios no puede leer las tablas, pero sí llamar a las funciones", async () => {
    await expect(asProbe(owner, "select count(*) as v from uniora.memberships")).rejects.toMatchObject({ code: "42501" });
    expect(await asProbe(owner, "select uniora.is_member('org-1') as v")).toBe(true);
  });

  it("is_member coincide con el motor para cada identidad y organización (bloqueados y alias incluidos)", async () => {
    const engine = createAuthorizationEngine(storage);
    for (const identity of identities) {
      for (const organizationId of orgs) {
        const expected = await engine.access.check({ identity, organizationId });
        expect(await asProbe(identity, "select uniora.is_member($1) as v", [organizationId]), `${identity.subject} @ ${organizationId}`).toBe(expected);
        expect(await asProbe(undefined, "select uniora.is_member($1, $2, $3) as v", [organizationId, identity.provider, identity.subject])).toBe(expected);
      }
    }
    expect(await asProbe(blocked, "select uniora.is_member('org-1') as v")).toBe(false);
    expect(await asProbe(alias, "select uniora.is_member('org-1') as v")).toBe(true);
  });

  it("una suspensión con fecha de fin deja de ser miembro hasta esa fecha y vuelve sola, igual que en el motor", async () => {
    const engine = createAuthorizationEngine(storage);
    const staffMembership = (await storage.memberships.findByIdentity("org-1", staff))!;
    await storage.memberships.block(staffMembership.id, { actor: owner, until: new Date(Date.now() + 700) });
    try {
      expect(await engine.access.check({ identity: staff, organizationId: "org-1" })).toBe(false);
      expect(await asProbe(staff, "select uniora.is_member('org-1') as v")).toBe(false);
      expect(await asProbe(staff, "select uniora.has_permission('org-1', 'vehicles.read') as v")).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(await engine.access.check({ identity: staff, organizationId: "org-1" })).toBe(true);
      expect(await asProbe(staff, "select uniora.is_member('org-1') as v")).toBe(true);
      expect(await asProbe(staff, "select uniora.has_permission('org-1', 'vehicles.read') as v")).toBe(true);
    } finally {
      await storage.memberships.unblock(staffMembership.id, { actor: owner });
    }
  });

  it("has_permission coincide con engine.can para cada identidad, organización y clave (malformadas y desconocidas incluidas)", async () => {
    const engine = createAuthorizationEngine(storage);
    for (const identity of identities) {
      for (const organizationId of orgs) {
        for (const permission of permissions) {
          const expected = await engine.can({ identity, organizationId, permission });
          const actual = await asProbe(identity, "select uniora.has_permission($1, $2) as v", [organizationId, permission]);
          expect(actual, `${identity.subject} @ ${organizationId} can ${JSON.stringify(permission)}`).toBe(expected);
        }
      }
    }
    // El Owner pasa cualquier clave bien formada, también una que no está registrada (comportamiento por defecto del motor).
    expect(await asProbe(owner, "select uniora.has_permission('org-1', 'never_registered.thing') as v")).toBe(true);
    // Permisos implícitos: vehicles.super -> vehicles.manage -> vehicles.write, pero no hacia vehicles.read ni hacia atrás.
    expect(await asProbe(manager, "select uniora.has_permission('org-1', 'vehicles.write') as v")).toBe(true);
    expect(await asProbe(manager, "select uniora.has_permission('org-1', 'vehicles.read') as v")).toBe(false);
    expect(await asProbe(staff, "select uniora.has_permission('org-1', 'vehicles.manage') as v")).toBe(false);
    // Un rol de OTRA organización no cuenta.
    expect(await asProbe(other, "select uniora.has_permission('org-1', 'vehicles.write') as v")).toBe(false);
  });

  it("owner_requires_registered_permission = on iguala el modo estricto del motor", async () => {
    const strict = createAuthorizationEngine(storage, { ownerRequiresRegisteredPermission: true });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${PROBE_ROLE}`);
      await client.query("select set_config('uniora.identity_provider', 'supabase', true), set_config('uniora.identity_subject', 'owner', true), set_config('uniora.owner_requires_registered_permission', 'on', true)");
      for (const permission of ["vehicles.read", "never_registered.thing"]) {
        const result = await client.query("select uniora.has_permission('org-1', $1) as v", [permission]);
        expect(result.rows[0].v).toBe(await strict.can({ identity: owner, organizationId: "org-1", permission }));
      }
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("is_feature_enabled coincide con features.isEnabled (override, valor por defecto y jerarquía)", async () => {
    for (const organizationId of orgs) {
      for (const key of features) {
        const expected = await storage.features.isEnabled(organizationId, key);
        expect(await asProbe(undefined, "select uniora.is_feature_enabled($1, $2) as v", [organizationId, key]), `${organizationId}/${key}`).toBe(expected);
      }
    }
    expect(await asProbe(undefined, "select uniora.is_feature_enabled('org-2', 'agenda_files') as v")).toBe(false); // padre apagado
    expect(await asProbe(undefined, "select uniora.is_feature_enabled('org-1', 'agenda_chat') as v")).toBe(true);
  });

  it("has_access coincide con engine.access.check para permiso, función y ambos", async () => {
    const engine = createAuthorizationEngine(storage);
    for (const identity of [owner, staff, blocked, stranger]) {
      for (const [permission, feature] of [
        [undefined, undefined],
        ["vehicles.read", undefined],
        [undefined, "agenda"],
        [undefined, "reports"],
        ["vehicles.read", "reports"],
        ["vehicles.write", "agenda"],
      ] as const) {
        const expected = await engine.access.check({ identity, organizationId: "org-1", permission, feature });
        const actual = await asProbe(identity, "select uniora.has_access('org-1', $1, $2) as v", [permission ?? null, feature ?? null]);
        expect(actual, `${identity.subject} ${permission}/${feature}`).toBe(expected);
      }
    }
  });

  it("una organización suspendida o archivada se niega igual que en el motor, y al reactivarla vuelve", async () => {
    const engine = createAuthorizationEngine(storage);
    const compare = async (label: string) => {
      for (const identity of [owner, staff, alias]) {
        expect(await asProbe(identity, "select uniora.is_member('org-1') as v"), `${label} member ${identity.subject}`).toBe(
          await engine.access.check({ identity, organizationId: "org-1" }),
        );
        expect(await asProbe(identity, "select uniora.has_permission('org-1', 'vehicles.read') as v"), `${label} permission ${identity.subject}`).toBe(
          await engine.can({ identity, organizationId: "org-1", permission: "vehicles.read" }),
        );
        expect(await asProbe(identity, "select uniora.has_access('org-1', null, 'agenda') as v"), `${label} access ${identity.subject}`).toBe(
          await engine.access.check({ identity, organizationId: "org-1", feature: "agenda" }),
        );
      }
    };
    try {
      for (const status of ["suspended", "archived"] as const) {
        await storage.organizations.setStatus("org-1", { status, actor: owner });
        await compare(status);
        expect(await asProbe(owner, "select uniora.is_member('org-1') as v")).toBe(false);
        expect(await asProbe(owner, "select uniora.has_permission('org-1', 'anything.at_all') as v")).toBe(false);
        expect(await asProbe(other, "select uniora.is_member('org-2') as v")).toBe(true); // otra organización: intacta
      }
    } finally {
      await storage.organizations.setStatus("org-1", { status: "active", actor: owner });
    }
    await compare("active");
    expect(await asProbe(owner, "select uniora.is_member('org-1') as v")).toBe(true);
  });

  it("sin identidad actual todo se niega, y nada lanza con entradas raras", async () => {
    expect(await asProbe(undefined, "select uniora.is_member('org-1') as v")).toBe(false);
    expect(await asProbe(undefined, "select uniora.has_permission('org-1', 'vehicles.read') as v")).toBe(false);
    expect(await asProbe(owner, "select uniora.is_member(null) as v")).toBe(false);
    expect(await asProbe(owner, "select uniora.has_permission('org-1', null) as v")).toBe(false);
    expect(await asProbe(undefined, "select uniora.is_feature_enabled(null, 'agenda') as v")).toBe(false);
    expect(await asProbe(undefined, "select uniora.is_feature_enabled('org-1', null) as v")).toBe(false);
  });

  it("EXECUTE está revocado a public: un rol sin concesión no puede llamarlas", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("create role uniora_rls_nogrant nologin");
      await client.query("grant usage on schema uniora to uniora_rls_nogrant");
      await client.query("set local role uniora_rls_nogrant");
      await expect(client.query("select uniora.is_member('org-1', 'a', 'b')")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("las funciones tienen search_path fijo y son security definer y stable", async () => {
    const result = await pool.query<{ proname: string; prosecdef: boolean; provolatile: string; proconfig: string[] | null }>(
      `select p.proname, p.prosecdef, p.provolatile, p.proconfig
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'uniora' and p.proname in ('is_member', 'has_permission', 'is_feature_enabled', 'has_access', 'active_membership_id')`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(7);
    for (const row of result.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.provolatile, row.proname).toBe("s");
      expect(row.proconfig?.some((setting) => setting.startsWith("search_path=pg_catalog")), row.proname).toBe(true);
    }
  });
});
