import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_SUBJECT_TEAMS, createAuthorizationEngine, createTrustedPolicyStorage, createTrustedTeamStorage } from "@uniora/core";
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
      "uniora.is_team_member(text, text)",
      "uniora.is_team_member(text, text, text, text)",
      "uniora.is_team_manager(text, text)",
      "uniora.is_team_manager(text, text, text, text)",
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

    // Teams: t-ops / t-sales / t-old (archived) in org-1 and t-other in org-2, with members in every state the engine tells apart.
    const trusted = createTrustedTeamStorage(storage, { actor: owner, reason: "rls team fixtures" });
    for (const [id, organizationId] of [["t-ops", "org-1"], ["t-sales", "org-1"], ["t-old", "org-1"], ["t-other", "org-2"]] as const) {
      await trusted.teams.create({ id, organizationId, name: id });
    }
    const join = (id: string, organizationId: string, teamId: string, membershipId: string, extra: { status?: "pending" | "active"; responsibility?: "owner" | "manager" | "member" } = {}) =>
      trusted.teamMemberships.add({ id, organizationId, teamId, membershipId, ...extra });
    await join("tm-staff-ops", "org-1", "t-ops", "m-staff");
    await join("tm-staff-sales", "org-1", "t-sales", "m-staff", { status: "pending" });
    await join("tm-manager-ops", "org-1", "t-ops", "m-manager", { responsibility: "manager" });
    await join("tm-manager-sales", "org-1", "t-sales", "m-manager", { responsibility: "owner" });
    await join("tm-owner-old", "org-1", "t-old", "m-owner", { responsibility: "owner" });
    await join("tm-blocked-ops", "org-1", "t-ops", "m-blocked");
    await join("tm-other", "org-2", "t-other", "m-other");
    await trusted.teams.archive("org-1", "t-old", { actor: owner });

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
    await storage.memberships.suspend(staffMembership.id, { actor: owner, until: new Date(Date.now() + 700) });
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

  const teamIds = ["t-ops", "t-sales", "t-old", "t-other", "t-ghost"];

  /** What the engine reads as `subject.teamIds` (or `managedTeamIds`): the active teams of the member the engine resolves, if it lets them in at all. */
  async function engineTeams(identity: Identity, organizationId: string, responsibilities?: ("owner" | "manager")[]): Promise<string[]> {
    if (!(await createAuthorizationEngine(storage).access.check({ identity, organizationId }))) return [];
    const membership = await storage.memberships.findByIdentity(organizationId, identity);
    if (!membership) return [];
    return storage.teamMemberships.activeTeamIds(organizationId, membership.id, responsibilities ? { responsibilities } : {});
  }

  /** The SQL function answers exactly what the engine says, for every identity, organization and team, in both forms. */
  async function expectTeamFunctionMatchesEngine(fn: "is_team_member" | "is_team_manager", label: string) {
    const responsibilities = fn === "is_team_manager" ? (["owner", "manager"] as ("owner" | "manager")[]) : undefined;
    for (const identity of identities) {
      for (const organizationId of orgs) {
        const expected = await engineTeams(identity, organizationId, responsibilities);
        for (const team of teamIds) {
          const where = `${label}: ${fn} ${identity.subject} @ ${organizationId}/${team}`;
          expect(await asProbe(identity, `select uniora.${fn}($1, $2) as v`, [organizationId, team]), where).toBe(expected.includes(team));
          expect(await asProbe(undefined, `select uniora.${fn}($1, $2, $3, $4) as v`, [organizationId, team, identity.provider, identity.subject]), where).toBe(expected.includes(team));
        }
      }
    }
  }

  it("is_team_member coincide con el motor para cada identidad, organización y equipo", async () => {
    await expectTeamFunctionMatchesEngine("is_team_member", "inicial");
    expect(await asProbe(staff, "select uniora.is_team_member('org-1', 't-ops') as v")).toBe(true);
    expect(await asProbe(staff, "select uniora.is_team_member('org-1', 't-sales') as v")).toBe(false); // pendiente
    expect(await asProbe(manager, "select uniora.is_team_member('org-1', 't-sales') as v")).toBe(true);
    expect(await asProbe(owner, "select uniora.is_team_member('org-1', 't-old') as v")).toBe(false); // equipo archivado
    expect(await asProbe(blocked, "select uniora.is_team_member('org-1', 't-ops') as v")).toBe(false); // persona bloqueada
  }, 60_000);

  it("is_team_member sigue los cambios de estado igual que el motor y vuelve al restaurar", async () => {
    const trusted = createTrustedTeamStorage(storage, { actor: owner, reason: "rls team fixtures" });
    await trusted.teams.archive("org-1", "t-ops", { actor: owner });
    await expectTeamFunctionMatchesEngine("is_team_member", "t-ops archivado");
    expect(await asProbe(staff, "select uniora.is_team_member('org-1', 't-ops') as v")).toBe(false);
    await trusted.teams.restore("org-1", "t-ops", { actor: owner });

    for (const status of ["suspended", "removed"] as const) {
      await trusted.teamMemberships.setStatus("org-1", "tm-staff-ops", status, { actor: owner });
      await expectTeamFunctionMatchesEngine("is_team_member", `membresía de equipo ${status}`);
      expect(await asProbe(staff, "select uniora.is_team_member('org-1', 't-ops') as v")).toBe(false);
    }
    await trusted.teamMemberships.add({ id: "tm-staff-ops", organizationId: "org-1", teamId: "t-ops", membershipId: "m-staff" });
    await expectTeamFunctionMatchesEngine("is_team_member", "membresía de equipo reincorporada");
    expect(await asProbe(staff, "select uniora.is_team_member('org-1', 't-ops') as v")).toBe(true);

    for (const status of ["suspended", "archived"] as const) {
      await storage.organizations.setStatus("org-1", { status, actor: owner });
      await expectTeamFunctionMatchesEngine("is_team_member", `organización ${status}`);
      expect(await asProbe(staff, "select uniora.is_team_member('org-1', 't-ops') as v")).toBe(false);
    }
    await storage.organizations.setStatus("org-1", { status: "active", actor: owner });
    await expectTeamFunctionMatchesEngine("is_team_member", "organización reactivada");
    expect(await asProbe(staff, "select uniora.is_team_member('org-1', 't-ops') as v")).toBe(true);
  }, 120_000);

  it("is_team_member: un equipo de otra organización, argumentos nulos o vacíos y sin identidad dan false, sin lanzar", async () => {
    expect(await asProbe(staff, "select uniora.is_team_member('org-1', 't-other') as v")).toBe(false); // equipo de org-2 con org-1 válida
    expect(await asProbe(other, "select uniora.is_team_member('org-2', 't-ops') as v")).toBe(false); // equipo de org-1 con org-2 válida
    expect(await asProbe(staff, "select uniora.is_team_member(null, 't-ops') as v")).toBe(false);
    expect(await asProbe(staff, "select uniora.is_team_member('org-1', null) as v")).toBe(false);
    expect(await asProbe(staff, "select uniora.is_team_member('', 't-ops') as v")).toBe(false);
    expect(await asProbe(staff, "select uniora.is_team_member('org-1', '') as v")).toBe(false);
    expect(await asProbe(undefined, "select uniora.is_team_member('org-1', 't-ops') as v")).toBe(false);
    for (const args of [["null", "'t-ops'", "'supabase'", "'staff'"], ["'org-1'", "null", "'supabase'", "'staff'"], ["'org-1'", "'t-ops'", "null", "'staff'"], ["'org-1'", "'t-ops'", "'supabase'", "null"]]) {
      expect(await asProbe(undefined, `select uniora.is_team_member(${args.join(", ")}) as v`), args.join(",")).toBe(false);
    }
  });

  it("is_team_member resuelve el alias como su identidad canónica", async () => {
    expect(await asProbe(alias, "select uniora.is_team_member('org-1', 't-ops') as v")).toBe(true);
    expect(await asProbe(undefined, "select uniora.is_team_member('org-1', 't-ops', 'clerk', 'staff-alias') as v")).toBe(true);
  });

  it("is_team_manager coincide con el motor: propietario y gerente sí, miembro no", async () => {
    await expectTeamFunctionMatchesEngine("is_team_manager", "inicial");
    expect(await asProbe(manager, "select uniora.is_team_manager('org-1', 't-ops') as v")).toBe(true); // gerente
    expect(await asProbe(manager, "select uniora.is_team_manager('org-1', 't-sales') as v")).toBe(true); // propietario
    expect(await asProbe(staff, "select uniora.is_team_manager('org-1', 't-ops') as v")).toBe(false); // solo miembro
    expect(await asProbe(owner, "select uniora.is_team_manager('org-1', 't-old') as v")).toBe(false); // equipo archivado
    expect(await asProbe(blocked, "select uniora.is_team_manager('org-1', 't-ops') as v")).toBe(false); // persona bloqueada
    expect(await asProbe(alias, "select uniora.is_team_manager('org-1', 't-ops') as v")).toBe(false); // alias de un miembro
  }, 60_000);

  it("is_team_manager sigue los cambios de responsabilidad y de estado igual que el motor", async () => {
    const trusted = createTrustedTeamStorage(storage, { actor: owner, reason: "rls team fixtures" });
    for (const [responsibility, expected] of [["manager", true], ["owner", true], ["member", false]] as const) {
      await trusted.teamMemberships.setResponsibility("org-1", "tm-staff-ops", responsibility);
      await expectTeamFunctionMatchesEngine("is_team_manager", `staff como ${responsibility}`);
      expect(await asProbe(staff, "select uniora.is_team_manager('org-1', 't-ops') as v"), responsibility).toBe(expected);
      expect(await asProbe(staff, "select uniora.is_team_member('org-1', 't-ops') as v"), `${responsibility} sigue siendo miembro`).toBe(true);
    }

    await trusted.teamMemberships.setStatus("org-1", "tm-manager-sales", "suspended", { actor: owner });
    await expectTeamFunctionMatchesEngine("is_team_manager", "responsable suspendido en el equipo");
    expect(await asProbe(manager, "select uniora.is_team_manager('org-1', 't-sales') as v")).toBe(false);
    await trusted.teamMemberships.setStatus("org-1", "tm-manager-sales", "active", { actor: owner });
    await expectTeamFunctionMatchesEngine("is_team_manager", "responsable reactivado");
    expect(await asProbe(manager, "select uniora.is_team_manager('org-1', 't-sales') as v")).toBe(true);
  }, 120_000);

  it("is_team_manager: un equipo de otra organización, argumentos nulos o vacíos y sin identidad dan false, sin lanzar", async () => {
    expect(await asProbe(manager, "select uniora.is_team_manager('org-1', 't-other') as v")).toBe(false);
    expect(await asProbe(other, "select uniora.is_team_manager('org-2', 't-sales') as v")).toBe(false);
    for (const call of ["(null, 't-ops')", "('org-1', null)", "('', 't-ops')", "('org-1', '')"]) {
      expect(await asProbe(manager, `select uniora.is_team_manager${call} as v`), call).toBe(false);
    }
    expect(await asProbe(undefined, "select uniora.is_team_manager('org-1', 't-ops') as v")).toBe(false);
    for (const args of [["null", "'t-ops'", "'supabase'", "'manager'"], ["'org-1'", "null", "'supabase'", "'manager'"], ["'org-1'", "'t-ops'", "null", "'manager'"], ["'org-1'", "'t-ops'", "'supabase'", "null"]]) {
      expect(await asProbe(undefined, `select uniora.is_team_manager(${args.join(", ")}) as v`), args.join(",")).toBe(false);
    }
  });

  it("una suspensión con fecha de fin saca a la persona de sus equipos hasta esa fecha y vuelve sola, igual que en el motor", async () => {
    // Longer than the member test's 700 ms: the database stamps `now()` with its own clock, which in a container can run ahead.
    const managerMembership = (await storage.memberships.findByIdentity("org-1", manager))!;
    await storage.memberships.suspend(managerMembership.id, { actor: owner, until: new Date(Date.now() + 1500) });
    try {
      expect(await engineTeams(manager, "org-1")).toEqual([]);
      for (const fn of ["is_team_member", "is_team_manager"]) {
        expect(await asProbe(manager, `select uniora.${fn}('org-1', 't-ops') as v`), `${fn} suspendido`).toBe(false);
        expect(await asProbe(undefined, `select uniora.${fn}('org-1', 't-sales', 'supabase', 'manager') as v`), `${fn} suspendido, identidad explícita`).toBe(false);
      }

      await new Promise((resolve) => setTimeout(resolve, 1800));
      expect(await engineTeams(manager, "org-1")).toEqual(["t-ops", "t-sales"]);
      for (const fn of ["is_team_member", "is_team_manager"]) {
        expect(await asProbe(manager, `select uniora.${fn}('org-1', 't-ops') as v`), `${fn} tras la fecha`).toBe(true);
        expect(await asProbe(manager, `select uniora.${fn}('org-1', 't-sales') as v`), `${fn} tras la fecha`).toBe(true);
      }
    } finally {
      await storage.memberships.unblock(managerMembership.id, { actor: owner });
    }
  }, 30_000);

  it("una política de alcance real evaluada por engine.authorize y is_team_member dan la misma respuesta", async () => {
    const trusted = createTrustedPolicyStorage(storage, { actor: owner, reason: "rls team fixtures" });
    await trusted.policies.create({
      id: "p-team-scope",
      organizationId: "org-1",
      key: "vehicle.team-scope",
      name: "Team scope",
      definition: { kind: "scope", effect: "require", actions: ["vehicles.read"], resourceType: "vehicle", condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamIds" }] } },
      createdBy: owner,
    });
    await trusted.policies.activate("org-1", "p-team-scope", { actor: owner });
    const engine = createAuthorizationEngine(storage);
    // Everyone here holds `vehicles.read` (staff and alias through a role, the Owner always) or is refused before the policy is read.
    for (const identity of [staff, alias, owner, blocked, stranger]) {
      for (const team of teamIds) {
        const decision = await engine.authorize({ identity, organizationId: "org-1", permission: "vehicles.read", resource: { type: "vehicle", id: "v-1", organizationId: "org-1", teamIds: [team] } });
        expect(await asProbe(identity, "select uniora.is_team_member('org-1', $1) as v", [team]), `${identity.subject} / ${team}: ${decision.decision}`).toBe(decision.decision === "allow");
      }
    }
    // A resource with no team is a fact ("none"), not a gap: nothing intersects, so nobody gets in — like a row without team in SQL.
    for (const identity of [staff, owner]) {
      const decision = await engine.authorize({ identity, organizationId: "org-1", permission: "vehicles.read", resource: { type: "vehicle", id: "v-1", organizationId: "org-1", teamIds: [] } });
      expect(decision.decision, `${identity.subject} sobre un recurso sin equipo`).not.toBe("allow");
    }
  }, 60_000);

  it("una política using (uniora.is_team_member(organization_id, team_id)) deja ver solo las filas del equipo", async () => {
    // The policies of guides/rls.md ("Policies by team"): members read a team's documents, only its leads read its payroll.
    const tables = ["rls_team_docs", "rls_team_payroll"];
    for (const table of tables) {
      await pool.query(`drop table if exists public.${table}`);
      await pool.query(`create table public.${table} (id int primary key, organization_id text not null, team_id text not null)`);
    }
    try {
      for (const table of tables) {
        await pool.query(`alter table public.${table} enable row level security`);
        await pool.query(`insert into public.${table} values (1, 'org-1', 't-ops'), (2, 'org-1', 't-sales'), (3, 'org-2', 't-other')`);
        await pool.query(`grant select on public.${table} to ${PROBE_ROLE}`);
      }
      await pool.query(`create policy "team reads" on public.rls_team_docs for select using (uniora.is_team_member(organization_id, team_id))`);
      await pool.query(`create policy "team leads read" on public.rls_team_payroll for select using (uniora.is_team_manager(organization_id, team_id))`);
      const visible = (table: string, identity: Identity | undefined) => asProbe<number[]>(identity, `select coalesce(array_agg(id order by id), '{}') as v from public.${table}`);
      expect(await visible("rls_team_docs", staff)).toEqual([1]); // t-ops sí; t-sales está pendiente
      expect(await visible("rls_team_docs", alias)).toEqual([1]);
      expect(await visible("rls_team_docs", manager)).toEqual([1, 2]);
      expect(await visible("rls_team_docs", other)).toEqual([3]);
      expect(await visible("rls_team_docs", blocked)).toEqual([]);
      expect(await visible("rls_team_docs", stranger)).toEqual([]);
      expect(await visible("rls_team_docs", undefined)).toEqual([]);
      expect(await visible("rls_team_payroll", manager)).toEqual([1, 2]); // gerente de t-ops, propietario de t-sales
      expect(await visible("rls_team_payroll", staff)).toEqual([]); // miembro, no responsable
      expect(await visible("rls_team_payroll", undefined)).toEqual([]);
    } finally {
      for (const table of tables) await pool.query(`drop table if exists public.${table}`);
    }
  });

  it("con más de MAX_SUBJECT_TEAMS equipos activos la función SQL sigue respondiendo con exactitud (el motor lo trataría como desconocido)", async () => {
    const big: Identity = { provider: "supabase", subject: "big" };
    const small: Identity = { provider: "supabase", subject: "small" };
    const count = MAX_SUBJECT_TEAMS + 1;
    // The organization stays after the test: an active policy cannot be deleted, and the next run's `truncate … cascade` clears it.
    await storage.organizations.create({ id: "org-big", name: "Grande" });
    await storage.roles.create({ id: "role-big", organizationId: "org-big", name: "Reader", permissionKeys: ["vehicles.read"] });
    const membership = await storage.memberships.create({ id: "m-big", organizationId: "org-big", identity: big, roleIds: ["role-big"] });
    await storage.memberships.create({ id: "m-small", organizationId: "org-big", identity: small, roleIds: ["role-big"] });
    await pool.query(
      "insert into uniora.teams (id, organization_id, slug, name) select 't-big-' || g, 'org-big', 'big-' || g, 'Big ' || g from generate_series(1, $1) g",
      [count],
    );
    await pool.query(
      "insert into uniora.team_memberships (id, organization_id, team_id, membership_id, status) select 'tm-big-' || g, 'org-big', 't-big-' || g, $2, 'active' from generate_series(1, $1) g",
      [count, membership.id],
    );
    await createTrustedTeamStorage(storage, { actor: owner, reason: "rls team fixtures" }).teamMemberships.add({ id: "tm-small-1", organizationId: "org-big", teamId: "t-big-1", membershipId: "m-small" });
    const trusted = createTrustedPolicyStorage(storage, { actor: owner, reason: "rls team fixtures" });
    await trusted.policies.create({
      id: "p-big-scope",
      organizationId: "org-big",
      key: "vehicle.team-scope",
      name: "Team scope",
      definition: { kind: "scope", effect: "require", actions: ["vehicles.read"], resourceType: "vehicle", condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamIds" }] } },
      createdBy: owner,
    });
    await trusted.policies.activate("org-big", "p-big-scope", { actor: owner });

    // The engine reads one more than the cap to notice it was exceeded (decider.ts), and then leaves `subject.teamIds` unknown.
    expect(await storage.teamMemberships.activeTeamIds("org-big", membership.id, { limit: MAX_SUBJECT_TEAMS + 1 })).toHaveLength(count);
    const engine = createAuthorizationEngine(storage);
    const authorize = (identity: Identity) =>
      engine.authorize({ identity, organizationId: "org-big", permission: "vehicles.read", resource: { type: "vehicle", id: "v-1", organizationId: "org-big", teamIds: ["t-big-1"] } });
    expect((await authorize(small)).decision, "control: una persona con un equipo es admitida por la política").toBe("allow");
    expect((await authorize(big)).decision, "el motor rechaza a quien supera el tope").not.toBe("allow");

    expect(await asProbe(small, "select uniora.is_team_member('org-big', 't-big-1') as v")).toBe(true);
    expect(await asProbe(big, `select uniora.is_team_member('org-big', 't-big-${count}') as v`)).toBe(true);
    expect(await asProbe(big, "select uniora.is_team_member('org-big', 't-big-1') as v")).toBe(true); // where the engine refuses
    expect(await asProbe(big, "select uniora.is_team_member('org-big', 't-big-0') as v")).toBe(false);
  }, 60_000);

  it("filas con varios equipos (text[]) y filas sin equipo: se ve la fila si cualquiera de sus equipos es tuyo y una fila sin equipo no la ve nadie", async () => {
    // The policies of guides/rls.md ("Rows of several teams, rows of none").
    for (const table of ["rls_team_multi", "rls_team_nullable"]) await pool.query(`drop table if exists public.${table}`);
    await pool.query("create table public.rls_team_multi (id int primary key, organization_id text not null, team_ids text[])");
    await pool.query("create table public.rls_team_nullable (id int primary key, organization_id text not null, team_id text)");
    try {
      for (const table of ["rls_team_multi", "rls_team_nullable"]) {
        await pool.query(`alter table public.${table} enable row level security`);
        await pool.query(`grant select on public.${table} to ${PROBE_ROLE}`);
      }
      await pool.query("insert into public.rls_team_multi values (1, 'org-1', '{t-ops,t-sales}'), (2, 'org-1', '{t-sales}'), (3, 'org-1', '{}'), (4, 'org-1', null)");
      await pool.query("insert into public.rls_team_nullable values (1, 'org-1', 't-ops'), (2, 'org-1', null)");
      await pool.query(`create policy "any of the row's teams" on public.rls_team_multi for select using (exists (select 1 from unnest(team_ids) as t(id) where uniora.is_team_member(organization_id, t.id)))`);
      await pool.query(`create policy "team reads" on public.rls_team_nullable for select using (uniora.is_team_member(organization_id, team_id))`);
      const visible = (table: string, identity: Identity | undefined) => asProbe<number[]>(identity, `select coalesce(array_agg(id order by id), '{}') as v from public.${table}`);
      expect(await visible("rls_team_multi", staff)).toEqual([1]); // t-ops is theirs; t-sales is only pending
      expect(await visible("rls_team_multi", manager)).toEqual([1, 2]); // either team is enough
      expect(await visible("rls_team_multi", stranger)).toEqual([]);
      expect(await visible("rls_team_multi", undefined)).toEqual([]);
      // Rows 3 (empty array) and 4 (NULL) have no team: nobody sees them, not even the Owner of the organization.
      expect(await visible("rls_team_multi", owner)).toEqual([]);
      expect(await visible("rls_team_nullable", staff)).toEqual([1]);
      expect(await visible("rls_team_nullable", owner)).toEqual([]);
    } finally {
      for (const table of ["rls_team_multi", "rls_team_nullable"]) await pool.query(`drop table if exists public.${table}`);
    }
  }, 30_000);

  it("con columnas uuid hay que convertir a text: lo que dice la guía funciona y sin convertir falla a la vista", async () => {
    const org = randomUUID();
    const team = randomUUID();
    const member: Identity = { provider: "supabase", subject: "uuid-member" };
    await storage.organizations.create({ id: org, name: "Uuid" });
    try {
      const membership = await storage.memberships.create({ id: randomUUID(), organizationId: org, identity: member });
      await createTrustedTeamStorage(storage, { actor: owner, reason: "rls team fixtures" }).teams.create({ id: team, organizationId: org, name: "Uuid team" });
      await createTrustedTeamStorage(storage, { actor: owner, reason: "rls team fixtures" }).teamMemberships.add({ id: randomUUID(), organizationId: org, teamId: team, membershipId: membership.id });
      await pool.query("drop table if exists public.rls_team_uuid");
      await pool.query("create table public.rls_team_uuid (id int primary key, organization_id uuid not null, team_id uuid not null)");
      try {
        await pool.query("alter table public.rls_team_uuid enable row level security");
        await pool.query("insert into public.rls_team_uuid values (1, $1, $2), (2, $1, $3)", [org, team, randomUUID()]);
        await pool.query(`grant select on public.rls_team_uuid to ${PROBE_ROLE}`);
        // As written without the cast, the policy cannot even be created: a visible error, never a silent "no rows".
        await expect(pool.query(`create policy "no cast" on public.rls_team_uuid for select using (uniora.is_team_member(organization_id, team_id))`)).rejects.toMatchObject({ code: "42883" });
        await pool.query(`create policy "team reads" on public.rls_team_uuid for select using (uniora.is_team_member(organization_id::text, team_id::text))`);
        expect(await asProbe<number[]>(member, "select coalesce(array_agg(id order by id), '{}') as v from public.rls_team_uuid")).toEqual([1]);
        expect(await asProbe<number[]>(stranger, "select coalesce(array_agg(id order by id), '{}') as v from public.rls_team_uuid")).toEqual([]);
      } finally {
        await pool.query("drop table if exists public.rls_team_uuid");
      }
    } finally {
      await pool.query("delete from uniora.organizations where id = $1", [org]);
    }
  }, 30_000);

  it("EXECUTE está revocado a public también en las funciones de equipo", async () => {
    for (const call of ["is_team_member('org-1', 't-ops')", "is_team_member('org-1', 't-ops', 'a', 'b')", "is_team_manager('org-1', 't-ops')", "is_team_manager('org-1', 't-ops', 'a', 'b')"]) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("create role uniora_rls_team_nogrant nologin");
        await client.query("grant usage on schema uniora to uniora_rls_team_nogrant");
        await client.query("set local role uniora_rls_team_nogrant");
        await expect(client.query(`select uniora.${call}`), call).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("rollback");
        client.release();
      }
    }
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
       where n.nspname = 'uniora' and p.proname in ('is_member', 'has_permission', 'is_feature_enabled', 'has_access', 'active_membership_id', 'is_team_member', 'is_team_manager')`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(11);
    for (const row of result.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.provolatile, row.proname).toBe("s");
      expect(row.proconfig?.some((setting) => setting.startsWith("search_path=pg_catalog")), row.proname).toBe(true);
    }
  });
});
