import { describe, expect, it } from "vitest";
import {
  PolicyError,
  createAuthorizationEngine,
  createOrganizationWithOwner,
  createTrustedPolicyStorage,
  createTrustedTeamStorage,
} from "@uniora/core";
import type { UnioraStorage } from "@uniora/core";

const admin = { provider: "supabase", subject: "admin" };
const ana = { provider: "supabase", subject: "ana" };
const owner1 = { provider: "supabase", subject: "owner-1" };

const scopeRule = {
  kind: "scope",
  effect: "require",
  actions: ["vehicles.update"],
  resourceType: "vehicle",
  condition: { intersects: [{ ref: "subject.teamIds" }, { ref: "resource.teamIds" }] },
};
const accessRule = { kind: "access", effect: "deny", actions: ["reports.run"], condition: { not: { exists: "subject.teamIds" } } };

/**
 * Raw SQL, in the adapter's dialect, for the assertions that must look UNDER the repositories: every `*Directly` call is a plain
 * statement any client with write access could issue, and resolves `"rejected"` when the database itself refuses it.
 */
export interface PolicyProbe {
  /** `update policy_revisions set note = ...` */
  updateRevisionDirectly(policyId: string, revision: number): Promise<"rejected" | "applied">;
  deleteRevisionDirectly(policyId: string, revision: number): Promise<"rejected" | "applied">;
  /** Sets a retired policy back to `active` (with the version bumped, so only the lifecycle rule can refuse it). */
  reviveRetiredDirectly(policyId: string): Promise<"rejected" | "applied">;
  /** A plain `delete from policies`. */
  deleteDirectly(policyId: string): Promise<"rejected" | "applied">;
  /** Inserts a revision row for `policyId` that claims to belong to another organization. */
  attachRevisionOfOtherOrganizationDirectly(policyId: string, organizationId: string): Promise<"rejected" | "applied">;
  /** Moves the policy to another organization. */
  moveToOtherOrganizationDirectly(policyId: string, organizationId: string): Promise<"rejected" | "applied">;
  /** Overwrites `definition_hash` of the policy row only. */
  changeHashDirectly(policyId: string): Promise<"rejected" | "applied">;
  /** Overwrites `definition` of the policy row without a new revision. */
  changeDefinitionDirectly(policyId: string): Promise<"rejected" | "applied">;
  /** Changes the name without bumping `version`. */
  skipVersionDirectly(policyId: string): Promise<"rejected" | "applied">;
  /** Inserts a policy row (valid in itself) without any revision row. */
  insertWithoutRevisionDirectly(organizationId: string, id: string): Promise<"rejected" | "applied">;
  /** Inserts `total` drafts with their revisions in one statement batch (to reach the per-organization limit quickly). */
  fillDraftsDirectly(organizationId: string, total: number): Promise<void>;
  /** A plain `delete from organizations`; the policies must go with it. */
  deleteOrganizationDirectly(organizationId: string): Promise<"rejected" | "applied">;
  /** Rows physically present for the organization. */
  countRows(organizationId: string): Promise<{ policies: number; revisions: number; counters: number }>;
}

/**
 * Policy storage conformance: the same lifecycle, isolation and tamper-resistance assertions for every adapter. Registered inside
 * `defineStorageConformance`, so it shares its database lifecycle.
 */
export function definePolicyConformance(harness: { storage(): UnioraStorage; policyProbe: PolicyProbe }): void {
  describe("policies — reglas declarativas por organización, ciclo de vida, revisiones inmutables y aislamiento", () => {
    async function seed() {
      const storage = harness.storage();
      for (const [org, name, role, member, who] of [
        ["org-1", "Acme", "role-owner", "m-owner", owner1],
        ["org-2", "Otra", "role-owner-2", "m-owner-2", admin],
      ] as const) {
        await createOrganizationWithOwner(storage, { organizationId: org, organizationName: name, ownerRoleId: role, membershipId: member, ownerIdentity: who });
      }
      await storage.permissions.register({ key: "vehicles.update" });
      await storage.permissions.register({ key: "reports.run" });
      await storage.roles.create({ id: "role-staff", organizationId: "org-1", name: "Staff", permissionKeys: ["vehicles.update", "reports.run"] });
      await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: ana, roleIds: ["role-staff"] });
      const teams = createTrustedTeamStorage(storage, { actor: admin, reason: "conformance fixtures" });
      await teams.teams.create({ id: "t-bcn", organizationId: "org-1", name: "Barcelona" });
      await teams.teams.create({ id: "t-mad", organizationId: "org-1", name: "Madrid" });
      await teams.teamMemberships.add({ id: "tm-ana", organizationId: "org-1", teamId: "t-bcn", membershipId: "m-ana" });
      const trusted = createTrustedPolicyStorage(storage, { actor: admin, reason: "conformance fixtures" });
      return { storage, trusted, teams };
    }
    type World = Awaited<ReturnType<typeof seed>>;

    const create = (w: World, id: string, key: string, definition: unknown = scopeRule, organizationId = "org-1") =>
      w.trusted.policies.create({ id, organizationId, key, name: key, definition, createdBy: admin });
    const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => (error instanceof PolicyError ? error.code : String(error)));

    it("crea un borrador con revisión 1, kind y effect derivados, y lo encuentra por id y por clave", async () => {
      const w = await seed();
      const created = await w.trusted.policies.create({ id: "p1", organizationId: "org-1", key: "vehicle.team-scope", name: "  Team   scope ", description: "Solo su equipo", definition: scopeRule, createdBy: admin, note: "first" });
      expect(created).toMatchObject({ id: "p1", organizationId: "org-1", key: "vehicle.team-scope", name: "Team scope", description: "Solo su equipo", kind: "scope", effect: "require", status: "draft", revision: 1, version: 1 });
      expect(created.definitionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.activatedAt).toBeUndefined();
      expect(await w.trusted.policies.findById("org-1", "p1")).toEqual(created);
      expect(await w.trusted.policies.findByKey("org-1", "vehicle.team-scope")).toEqual(created);
      const revision = await w.trusted.policies.findRevision("org-1", "p1", 1);
      expect(revision).toMatchObject({ policyId: "p1", organizationId: "org-1", revision: 1, definitionHash: created.definitionHash, note: "first", createdBy: admin });
      expect(revision?.definition).toEqual(created.definition);
    });

    it("rechaza duplicados, organizaciones desconocidas y definiciones inválidas con códigos estables", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      expect(await code(create(w, "p1", "two"))).toBe("policy_exists");
      expect(await code(create(w, "p2", "one"))).toBe("policy_key_taken");
      expect(await code(create(w, "p2", "two", scopeRule, "nope"))).toBe("policy_organization_unknown");
      expect(await code(create(w, "p2", "Bad Key"))).toBe("policy_key_invalid");
      expect(await code(create(w, "p2", "two", { kind: "access", effect: "allow", actions: ["x.y"], condition: { exists: "subject.teamIds" } }))).toBe("policy_definition_invalid");
      expect(await code(create(w, "p2", "two", { ...accessRule, code: "process.exit()" }))).toBe("policy_definition_invalid");
      // La misma clave en OTRA organización es válida: la unicidad es por organización.
      await create(w, "p-other", "one", scopeRule, "org-2");
    });

    it("una política de otra organización no existe: se lee, lista y modifica como si faltara", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      await create(w, "p-other", "other", accessRule, "org-2");
      expect(await w.trusted.policies.findById("org-2", "p1")).toBeNull();
      expect(await w.trusted.policies.findByKey("org-2", "one")).toBeNull();
      expect(await w.trusted.policies.findRevision("org-2", "p1", 1)).toBeNull();
      expect((await w.trusted.policies.search({ organizationId: "org-2" })).map((p) => p.id)).toEqual(["p-other"]);
      expect(await w.trusted.policies.count({ organizationId: "org-1" })).toBe(1);
      expect(await code(w.trusted.policies.update("org-2", "p1", { actor: admin, name: "Hacked" }))).toBe("policy_not_found");
      expect(await code(w.trusted.policies.activate("org-2", "p1", { actor: admin }))).toBe("policy_not_found");
      expect(await code(w.trusted.policies.delete("org-2", "p1"))).toBe("policy_not_found");
      expect(await code(w.trusted.policies.revisions("org-2", "p1"))).toBe("policy_not_found");
      expect((await w.trusted.policies.findById("org-1", "p1"))?.name).toBe("one");
    });

    it("sin autorización de política, el almacenamiento rechaza toda escritura", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      const raw = w.storage.policies;
      const forged = { organizationId: "org-1", actor: admin } as never;
      expect(await code(raw.create({ authorization: undefined as never, id: "p2", organizationId: "org-1", key: "two", name: "Two", definition: scopeRule, createdBy: admin }))).toBe("policy_authorization_required");
      expect(await code(raw.create({ authorization: forged, id: "p2", organizationId: "org-1", key: "two", name: "Two", definition: scopeRule, createdBy: admin }))).toBe("policy_authorization_required");
      expect(await code(raw.update("org-1", "p1", { authorization: forged, actor: admin, name: "X" }))).toBe("policy_authorization_required");
      expect(await code(raw.activate("org-1", "p1", { authorization: forged, actor: admin }))).toBe("policy_authorization_required");
      expect(await code(raw.delete("org-1", "p1", { authorization: forged }))).toBe("policy_authorization_required");
      expect((await w.trusted.policies.findById("org-1", "p1"))?.status).toBe("draft");
    });

    it("cambiar nombre o descripción no crea revisión; cambiar la definición sí, y el historial se conserva", async () => {
      const w = await seed();
      const created = await create(w, "p1", "one");
      const renamed = await w.trusted.policies.update("org-1", "p1", { actor: ana, name: "Uno", description: "desc" });
      expect(renamed).toMatchObject({ name: "Uno", description: "desc", revision: 1, version: 2, definitionHash: created.definitionHash });
      const cleared = await w.trusted.policies.update("org-1", "p1", { actor: ana, description: null });
      expect(cleared.description).toBeUndefined();
      expect(cleared.version).toBe(3);
      // La misma definición no cambia nada.
      const same = await w.trusted.policies.update("org-1", "p1", { actor: ana, definition: scopeRule, name: "Uno" });
      expect(same.version).toBe(3);
      const next = { ...scopeRule, actions: ["vehicles.update", "vehicles.read"] };
      const revised = await w.trusted.policies.update("org-1", "p1", { actor: ana, definition: next, note: "also read" });
      expect(revised).toMatchObject({ revision: 2, version: 4 });
      expect(revised.definitionHash).not.toBe(created.definitionHash);
      expect(revised.definition.actions).toEqual(["vehicles.read", "vehicles.update"]);
      const history = await w.trusted.policies.revisions("org-1", "p1");
      expect(history.map((row) => row.revision)).toEqual([2, 1]);
      expect(history[0]).toMatchObject({ note: "also read", createdBy: ana, definitionHash: revised.definitionHash });
      expect(history[1]!.definition).toEqual(created.definition);
      expect((await w.trusted.policies.revisions("org-1", "p1", { before: 2 })).map((row) => row.revision)).toEqual([1]);
      expect(await code(w.trusted.policies.update("org-1", "p1", { actor: ana }))).toBe("policy_update_empty");
      expect(await code(w.trusted.policies.update("org-1", "p1", { actor: ana, definition: { kind: "access" } }))).toBe("policy_definition_invalid");
      expect((await w.trusted.policies.findById("org-1", "p1"))?.revision).toBe(2);
    });

    it("version optimista: expectedVersion distinto es un conflicto y no cambia nada", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      expect(await code(w.trusted.policies.update("org-1", "p1", { actor: ana, name: "X", expectedVersion: 5 }))).toBe("policy_version_conflict");
      expect(await code(w.trusted.policies.activate("org-1", "p1", { actor: ana, expectedVersion: 5 }))).toBe("policy_version_conflict");
      expect((await w.trusted.policies.update("org-1", "p1", { actor: ana, name: "X", expectedVersion: 1 })).version).toBe(2);
    });

    it("ciclo de vida: draft → active ⇄ disabled → retired; retired es definitivo y conserva su clave", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      expect(await code(w.trusted.policies.disable("org-1", "p1", { actor: ana }))).toBe("policy_transition_invalid");
      expect(await code(w.trusted.policies.retire("org-1", "p1", { actor: ana }))).toBe("policy_transition_invalid");
      const active = await w.trusted.policies.activate("org-1", "p1", { actor: ana, reason: "go" });
      expect(active).toMatchObject({ status: "active", version: 2 });
      expect(active.activatedAt).toBeInstanceOf(Date);
      expect(active.statusChange).toMatchObject({ by: ana, reason: "go" });
      // Idempotente: no cambia la versión.
      expect((await w.trusted.policies.activate("org-1", "p1", { actor: ana })).version).toBe(2);
      const disabled = await w.trusted.policies.disable("org-1", "p1", { actor: ana });
      expect(disabled.status).toBe("disabled");
      const again = await w.trusted.policies.activate("org-1", "p1", { actor: ana });
      expect(again.activatedAt).toEqual(active.activatedAt);
      const retired = await w.trusted.policies.retire("org-1", "p1", { actor: ana, reason: "obsolete" });
      expect(retired.status).toBe("retired");
      expect(await code(w.trusted.policies.activate("org-1", "p1", { actor: ana }))).toBe("policy_retired");
      expect(await code(w.trusted.policies.update("org-1", "p1", { actor: ana, name: "Zombie" }))).toBe("policy_retired");
      expect((await w.trusted.policies.retire("org-1", "p1", { actor: ana })).version).toBe(retired.version);
      expect(await code(create(w, "p2", "one"))).toBe("policy_key_taken");
    });

    it("solo se borra un borrador que nunca estuvo activo; las revisiones se van con él", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      await w.trusted.policies.update("org-1", "p1", { actor: ana, definition: { ...scopeRule, actions: ["vehicles.read"] } });
      await w.trusted.policies.delete("org-1", "p1");
      expect(await w.trusted.policies.findById("org-1", "p1")).toBeNull();
      expect(await harness.policyProbe.countRows("org-1")).toEqual({ policies: 0, revisions: 0, counters: 1 });
      await create(w, "p2", "two");
      await w.trusted.policies.activate("org-1", "p2", { actor: ana });
      await w.trusted.policies.disable("org-1", "p2", { actor: ana });
      expect(await code(w.trusted.policies.delete("org-1", "p2"))).toBe("policy_not_draft");
      expect(await code(w.trusted.policies.delete("org-1", "missing"))).toBe("policy_not_found");
      // La clave de un borrador borrado vuelve a estar libre.
      await create(w, "p3", "one");
    });

    it("el contador del conjunto sube con cada cambio y activeSet solo trae las activas de esa organización", async () => {
      const w = await seed();
      expect(await w.trusted.policies.setRevision("org-1")).toBe(0);
      expect(await w.trusted.policies.activeSet("org-1")).toEqual({ revision: 0, policies: [] });
      await create(w, "p1", "one");
      await create(w, "p2", "two", accessRule);
      await create(w, "p-other", "other", accessRule, "org-2");
      const afterCreate = await w.trusted.policies.setRevision("org-1");
      expect(afterCreate).toBeGreaterThan(0);
      await w.trusted.policies.activate("org-1", "p2", { actor: ana });
      await w.trusted.policies.activate("org-2", "p-other", { actor: ana });
      const set = await w.trusted.policies.activeSet("org-1");
      expect(set.revision).toBeGreaterThan(afterCreate);
      expect(set.policies.map((p) => p.id)).toEqual(["p2"]);
      expect(await w.trusted.policies.setRevision("org-2")).toBeGreaterThan(0);
      // Un cambio sin efecto no mueve el contador.
      await w.trusted.policies.activate("org-1", "p2", { actor: ana });
      expect(await w.trusted.policies.setRevision("org-1")).toBe(set.revision);
      await w.trusted.policies.disable("org-1", "p2", { actor: ana });
      expect((await w.trusted.policies.activeSet("org-1")).policies).toEqual([]);
      expect(await w.trusted.policies.setRevision("org-1")).toBeGreaterThan(set.revision);
    });

    it("el número de revisión no se repite nunca: una organización borrada y creada otra vez con el mismo id no vuelve a un número ya usado", async () => {
      const w = await seed();
      const seen = new Set<number>();
      await create(w, "p1", "one");
      seen.add(await w.trusted.policies.setRevision("org-1"));
      await w.trusted.policies.activate("org-1", "p1", { actor: ana });
      const last = await w.trusted.policies.setRevision("org-1");
      seen.add(last);
      expect(seen.size).toBe(2);
      expect(await harness.policyProbe.deleteOrganizationDirectly("org-1")).toBe("applied");
      expect(await w.trusted.policies.setRevision("org-1")).toBe(0);
      await createOrganizationWithOwner(w.storage, { organizationId: "org-1", organizationName: "Acme otra vez", ownerRoleId: "role-owner", membershipId: "m-owner", ownerIdentity: owner1 });
      await create(w, "p1", "one");
      const again = await w.trusted.policies.setRevision("org-1");
      expect(seen.has(again)).toBe(false);
      expect(again).toBeGreaterThan(last);
    });

    it("lista con filtros, búsqueda de texto, paginación por cursor y conteo acotado", async () => {
      const w = await seed();
      for (let i = 1; i <= 5; i++) await create(w, `p${i}`, `rule-${i}`, i % 2 ? scopeRule : accessRule);
      await w.trusted.policies.activate("org-1", "p2", { actor: ana });
      const ids = async (options: object) => (await w.trusted.policies.search({ organizationId: "org-1", ...options })).map((p) => p.id);
      expect(await ids({})).toEqual(["p1", "p2", "p3", "p4", "p5"]);
      expect(await ids({ limit: 2 })).toEqual(["p1", "p2"]);
      expect(await ids({ limit: 2, after: "p2" })).toEqual(["p3", "p4"]);
      expect(await ids({ status: "active" })).toEqual(["p2"]);
      expect(await ids({ kind: "scope" })).toEqual(["p1", "p3", "p5"]);
      expect(await ids({ effect: "deny" })).toEqual(["p2", "p4"]);
      expect(await ids({ query: "RULE-3" })).toEqual(["p3"]);
      expect(await ids({ query: "rule_" })).toEqual([]);
      expect(await w.trusted.policies.count({ organizationId: "org-1", kind: "scope" })).toBe(3);
      expect(await w.trusted.policies.count({ organizationId: "org-1", limit: 2 })).toBe(2);
      expect(await code(w.trusted.policies.search({ organizationId: "org-1", status: "nope" as never }))).toBe("policy_invalid");
    });

    it("subject.teamIds viene de la base: solo equipos activos con membresía activa", async () => {
      const w = await seed();
      expect(await w.storage.teamMemberships.activeTeamIds("org-1", "m-ana")).toEqual(["t-bcn"]);
      await w.teams.teamMemberships.add({ id: "tm-ana-2", organizationId: "org-1", teamId: "t-mad", membershipId: "m-ana" });
      expect(await w.storage.teamMemberships.activeTeamIds("org-1", "m-ana")).toEqual(["t-bcn", "t-mad"]);
      expect(await w.storage.teamMemberships.activeTeamIds("org-1", "m-ana", { limit: 1 })).toEqual(["t-bcn"]);
      await w.teams.teamMemberships.setStatus("org-1", "tm-ana-2", "suspended", { actor: admin });
      expect(await w.storage.teamMemberships.activeTeamIds("org-1", "m-ana")).toEqual(["t-bcn"]);
      await w.teams.teams.archive("org-1", "t-bcn", { actor: admin });
      expect(await w.storage.teamMemberships.activeTeamIds("org-1", "m-ana")).toEqual([]);
      expect(await w.storage.teamMemberships.activeTeamIds("org-2", "m-ana")).toEqual([]);
    });

    it("el motor decide con las políticas guardadas: restringe, nunca concede, y una política de otra organización no cuenta", async () => {
      const w = await seed();
      await create(w, "p1", "team-scope");
      await create(w, "p-other", "other-scope", { kind: "access", effect: "deny", actions: ["vehicles.update"], condition: { exists: "subject.teamIds" } }, "org-2");
      await w.trusted.policies.activate("org-1", "p1", { actor: ana });
      await w.trusted.policies.activate("org-2", "p-other", { actor: ana });
      const engine = createAuthorizationEngine(w.storage);
      const vehicle = (teamIds: string[]) => ({ type: "vehicle", id: "v-1", organizationId: "org-1", teamIds, attributes: {} });
      const ask = (resource: ReturnType<typeof vehicle>, permission = "vehicles.update") => engine.authorize({ identity: ana, organizationId: "org-1", permission, resource });
      const mine = await ask(vehicle(["t-bcn"]));
      expect(mine).toMatchObject({ decision: "allow", allowed: true, reason: "allowed" });
      expect(mine.policies).toHaveLength(1);
      expect(mine.policies[0]).toMatchObject({ policyId: "p1", key: "team-scope", revision: 1, result: "allow" });
      expect(await ask(vehicle(["t-mad"]))).toMatchObject({ decision: "deny", allowed: false, reason: "policy_denied" });
      // Sin el permiso de rol, ninguna política concede nada.
      expect(await ask(vehicle(["t-bcn"]), "reports.delete")).toMatchObject({ allowed: false, reason: "permission_denied" });
      // Un recurso de otra organización se rechaza antes de mirar políticas.
      expect(await engine.authorize({ identity: ana, organizationId: "org-1", permission: "vehicles.update", resource: { ...vehicle(["t-bcn"]), organizationId: "org-2" } })).toMatchObject({ allowed: false, reason: "cross_tenant_resource" });
      // Cambiar la política se nota en la siguiente decisión (la caché va por el contador del conjunto).
      await w.trusted.policies.disable("org-1", "p1", { actor: ana });
      expect(await ask(vehicle(["t-mad"]))).toMatchObject({ decision: "allow", allowed: true });
    });

    it("la base rechaza SQL directo sobre revisiones: ni se editan ni se borran sueltas", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      await w.trusted.policies.update("org-1", "p1", { actor: ana, definition: { ...scopeRule, actions: ["vehicles.read"] } });
      const { policyProbe: probe } = harness;
      expect(await probe.updateRevisionDirectly("p1", 1)).toBe("rejected");
      expect(await probe.updateRevisionDirectly("p1", 2)).toBe("rejected");
      expect(await probe.deleteRevisionDirectly("p1", 1)).toBe("rejected");
      expect(await probe.deleteRevisionDirectly("p1", 2)).toBe("rejected");
      expect((await w.trusted.policies.revisions("org-1", "p1")).map((row) => row.revision)).toEqual([2, 1]);
    });

    it("la base rechaza resucitar una política retirada y borrar una que estuvo activa", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      await create(w, "p2", "two");
      await w.trusted.policies.activate("org-1", "p1", { actor: ana });
      await w.trusted.policies.retire("org-1", "p1", { actor: ana });
      await w.trusted.policies.activate("org-1", "p2", { actor: ana });
      const { policyProbe: probe } = harness;
      expect(await probe.reviveRetiredDirectly("p1")).toBe("rejected");
      expect(await probe.deleteDirectly("p1")).toBe("rejected");
      expect(await probe.deleteDirectly("p2")).toBe("rejected");
      expect((await w.trusted.policies.findById("org-1", "p1"))?.status).toBe("retired");
      expect((await w.trusted.policies.findById("org-1", "p2"))?.status).toBe("active");
    });

    it("la base rechaza mezclar organizaciones, desalinear el hash o la definición y saltarse la versión", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      const { policyProbe: probe } = harness;
      expect(await probe.attachRevisionOfOtherOrganizationDirectly("p1", "org-2")).toBe("rejected");
      expect(await probe.moveToOtherOrganizationDirectly("p1", "org-2")).toBe("rejected");
      expect(await probe.changeHashDirectly("p1")).toBe("rejected");
      expect(await probe.changeDefinitionDirectly("p1")).toBe("rejected");
      expect(await probe.skipVersionDirectly("p1")).toBe("rejected");
      expect(await probe.insertWithoutRevisionDirectly("org-1", "orphan")).toBe("rejected");
      expect(await w.trusted.policies.findById("org-1", "orphan")).toBeNull();
      expect(await w.trusted.policies.findById("org-1", "p1")).toMatchObject({ version: 1, revision: 1, name: "one" });
      expect(await probe.countRows("org-2")).toEqual({ policies: 0, revisions: 0, counters: 0 });
    });

    it("límites: 1000 políticas por organización y 200 activas", async () => {
      const w = await seed();
      await harness.policyProbe.fillDraftsDirectly("org-1", 1000);
      expect(await w.trusted.policies.count({ organizationId: "org-1" })).toBe(1000);
      expect(await code(create(w, "overflow", "overflow"))).toBe("policy_limit_reached");
      // Otra organización no se ve afectada.
      await create(w, "p-other", "one", scopeRule, "org-2");
      // 200 activas: la 201 se rechaza, aunque haya borradores de sobra.
      for (let i = 0; i < 200; i++) await w.trusted.policies.activate("org-1", `fill-${String(i).padStart(4, "0")}`, { actor: ana });
      expect(await code(w.trusted.policies.activate("org-1", "fill-0200", { actor: ana }))).toBe("policy_limit_reached");
      expect((await w.trusted.policies.activeSet("org-1")).policies).toHaveLength(200);
      await w.trusted.policies.disable("org-1", "fill-0000", { actor: ana });
      expect((await w.trusted.policies.activate("org-1", "fill-0200", { actor: ana })).status).toBe("active");
    }, 60_000);

    it("dos activaciones simultáneas en el límite: solo una cabe", async () => {
      const w = await seed();
      await harness.policyProbe.fillDraftsDirectly("org-1", 202);
      for (let i = 0; i < 199; i++) await w.trusted.policies.activate("org-1", `fill-${String(i).padStart(4, "0")}`, { actor: ana });
      const results = await Promise.all([
        code(w.trusted.policies.activate("org-1", "fill-0199", { actor: ana })),
        code(w.trusted.policies.activate("org-1", "fill-0200", { actor: ana })),
      ]);
      expect(results.sort()).toEqual(["ok", "policy_limit_reached"]);
      expect((await w.trusted.policies.activeSet("org-1")).policies).toHaveLength(200);
    }, 60_000);

    it("dos cambios simultáneos con la misma versión: uno gana y el otro es un conflicto", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      const results = await Promise.all([
        code(w.trusted.policies.update("org-1", "p1", { actor: ana, name: "A", expectedVersion: 1 })),
        code(w.trusted.policies.update("org-1", "p1", { actor: ana, name: "B", expectedVersion: 1 })),
      ]);
      expect(results.sort()).toEqual(["ok", "policy_version_conflict"]);
      expect((await w.trusted.policies.findById("org-1", "p1"))?.version).toBe(2);
    });

    it("borrar la organización se lleva sus políticas, revisiones y contador, activas o no", async () => {
      const w = await seed();
      await create(w, "p1", "one");
      await create(w, "p2", "two");
      await w.trusted.policies.update("org-1", "p2", { actor: ana, definition: { ...scopeRule, actions: ["vehicles.read"] } });
      await w.trusted.policies.activate("org-1", "p2", { actor: ana });
      await create(w, "p-other", "one", scopeRule, "org-2");
      expect(await harness.policyProbe.countRows("org-1")).toEqual({ policies: 2, revisions: 3, counters: 1 });
      expect(await harness.policyProbe.deleteOrganizationDirectly("org-1")).toBe("applied");
      expect(await harness.policyProbe.countRows("org-1")).toEqual({ policies: 0, revisions: 0, counters: 0 });
      expect(await harness.policyProbe.countRows("org-2")).toEqual({ policies: 1, revisions: 1, counters: 1 });
    });
  });
}
