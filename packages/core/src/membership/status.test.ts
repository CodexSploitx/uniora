import { afterEach, describe, expect, it, vi } from "vitest";
import { computeAuthorizationSnapshot, createAuthorizationEngine, createAuditedStorage } from "../index.js";
import { createMemoryStorage } from "../storage/memory.js";

const admin = { provider: "p", subject: "admin" };
const alice = { provider: "p", subject: "alice" };
const bob = { provider: "p", subject: "bob" };

async function setup() {
  const storage = createMemoryStorage();
  await storage.organizations.create({ id: "org", name: "Acme" });
  await storage.permissions.register({ key: "reports.read" });
  await storage.features.register({ key: "agenda", name: "Agenda", defaultEnabled: true });
  const owner = await storage.roles.createOwnerRole({ id: "owner", organizationId: "org" });
  const staff = await storage.roles.create({ id: "staff", organizationId: "org", name: "Staff", permissionKeys: ["reports.read"] });
  const a = await storage.memberships.create({ id: "m-alice", organizationId: "org", identity: alice, roleIds: [staff.id], invitedBy: admin });
  const b = await storage.memberships.create({ id: "m-bob", organizationId: "org", identity: bob });
  await storage.memberships.assignOwnerRole(b.id, owner.id);
  return { storage, owner, staff, a, b };
}

describe("MembershipRepository: estado, fechas y autoría", () => {
  it("una membresía nace activa, con fechas y quién invitó", async () => {
    const { storage, a, b } = await setup();
    expect(a).toMatchObject({ status: "active", invitedBy: admin });
    expect(a.createdAt).toBeInstanceOf(Date);
    expect(a.updatedAt.getTime()).toBe(a.createdAt.getTime());
    expect(a.lastActiveAt).toBeUndefined();
    expect(b.invitedBy).toBeUndefined();
    expect((await storage.memberships.findById("m-alice"))?.status).toBe("active");
  });

  it("asignar y quitar roles actualiza updatedAt, no createdAt", async () => {
    const { storage, a } = await setup();
    const created = a.createdAt.getTime();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await storage.roles.create({ id: "other", organizationId: "org", name: "Other" });
    await storage.memberships.assignRole("m-alice", "other");
    const after = (await storage.memberships.findById("m-alice"))!;
    expect(after.createdAt.getTime()).toBe(created);
    expect(after.updatedAt.getTime()).toBeGreaterThan(created);
  });

  it("bloquear no elimina: conserva roles pero el motor lo deniega todo (can, access.check y snapshots)", async () => {
    const { storage, a } = await setup();
    const engine = createAuthorizationEngine(storage);
    const input = { identity: alice, organizationId: "org", permission: "reports.read" };
    expect(await engine.can(input)).toBe(true);
    expect(await engine.access.check({ ...input, feature: "agenda" })).toBe(true);

    const blocked = await storage.memberships.block(a.id, { actor: admin, reason: "  impago  " });

    expect(blocked).toMatchObject({ status: "blocked", roleIds: ["staff"], blocked: { by: admin, reason: "impago" } });
    expect(blocked.blocked!.at).toBeInstanceOf(Date);
    expect(await engine.can(input)).toBe(false);
    expect(await engine.access.check({ ...input, feature: "agenda" })).toBe(false);
    expect(await engine.access.check({ identity: alice, organizationId: "org" })).toBe(false);
    expect(await engine.access.check({ identity: alice, organizationId: "org", feature: "agenda" })).toBe(false);
    const snapshot = await computeAuthorizationSnapshot(engine, storage.features, {
      identity: alice,
      organizationId: "org",
      permissions: ["reports.read"],
      features: ["agenda"],
    });
    expect(snapshot).toEqual({ organizationId: "org", permissions: { "reports.read": false }, features: { agenda: false } });
    // Los demás siguen igual.
    expect(await engine.can({ identity: bob, organizationId: "org", permission: "reports.read" })).toBe(true);

    await storage.memberships.unblock(a.id, { actor: admin });
    expect(await engine.can(input)).toBe(true);
    expect((await storage.memberships.findById(a.id))!.blocked).toBeUndefined();
  });

  it("bloquear y desbloquear son idempotentes; el primer bloqueo conserva autor y motivo", async () => {
    const { storage, a } = await setup();
    await storage.memberships.block(a.id, { actor: admin, reason: "uno" });
    const again = await storage.memberships.block(a.id, { actor: bob, reason: "dos" });
    expect(again.blocked).toMatchObject({ by: admin, reason: "uno" });
    await storage.memberships.unblock(a.id, { actor: admin });
    expect((await storage.memberships.unblock(a.id, { actor: admin })).status).toBe("active");
    await expect(storage.memberships.block("nope", { actor: admin })).rejects.toMatchObject({ code: "membership_not_found" });
    await expect(storage.memberships.unblock("nope", { actor: admin })).rejects.toMatchObject({ code: "membership_not_found" });
  });

  it("no se puede bloquear al último Owner activo, pero sí a uno de dos", async () => {
    const { storage, owner, a, b } = await setup();
    await expect(storage.memberships.block(b.id, { actor: admin })).rejects.toMatchObject({ code: "last_owner" });
    expect((await storage.memberships.findById(b.id))!.status).toBe("active");

    await storage.memberships.assignOwnerRole(a.id, owner.id);
    await storage.memberships.block(b.id, { actor: admin });
    // Ahora a es el único Owner activo.
    await expect(storage.memberships.block(a.id, { actor: admin })).rejects.toMatchObject({ code: "last_owner" });
  });

  it("filtra y cuenta por estado, y el listado lo trae", async () => {
    const { storage, a } = await setup();
    await storage.memberships.block(a.id, { actor: admin });
    expect((await storage.memberships.search({ organizationId: "org", status: "blocked" })).map((m) => m.id)).toEqual(["m-alice"]);
    expect(await storage.memberships.count({ organizationId: "org", status: "active" })).toBe(1);
    expect(await storage.memberships.count({ organizationId: "org" })).toBe(2);
    const listing = await storage.memberships.searchListing({ organizationId: "org", rolesPerMember: 2, status: "blocked" });
    expect(listing).toMatchObject([{ id: "m-alice", status: "blocked", invitedBy: admin }]);
    expect(listing[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("recordActivity solo avanza lastActiveAt y no toca updatedAt", async () => {
    const { storage, a } = await setup();
    const updated = a.updatedAt.getTime();
    const later = new Date(Date.now() + 60_000);
    await storage.memberships.recordActivity(a.id, later);
    await storage.memberships.recordActivity(a.id, new Date(later.getTime() - 30_000));
    await storage.memberships.recordActivity("nope");
    const found = (await storage.memberships.findById(a.id))!;
    expect(found.lastActiveAt).toEqual(later);
    expect(found.updatedAt.getTime()).toBe(updated);
  });

  it("createAuditedStorage audita el bloqueo con actor y motivo", async () => {
    const { storage, a } = await setup();
    const audited = createAuditedStorage(storage, { actor: admin });
    await audited.memberships.block(a.id, { actor: admin, reason: "fraude" });
    await audited.memberships.unblock(a.id, { actor: admin });
    const entries = await storage.auditLogs.listByOrganization("org");
    expect(entries.map((e) => e.action).sort()).toEqual(["membership.blocked", "membership.unblocked"]);
    expect(entries.find((e) => e.action === "membership.blocked")!.metadata).toMatchObject({ reason: "fraude" });
  });
});

describe("MembershipRepository: suspensión con fecha de fin (memoria)", () => {
  afterEach(() => vi.useRealTimers());

  it("bloquea hasta la fecha, se reactiva sola, y se audita con la fecha", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-07T10:00:00Z") });
    const { storage } = await setup();
    const audited = createAuditedStorage(storage, { actor: admin });
    const engine = createAuthorizationEngine(storage);
    const input = { identity: alice, organizationId: "org", permission: "reports.read" };
    const until = new Date("2026-10-07T12:00:00Z");

    const suspended = await audited.memberships.block("m-alice", { actor: admin, reason: "vacaciones", until });
    expect(suspended).toMatchObject({ status: "blocked", blocked: { reason: "vacaciones", until } });
    expect(await engine.can(input)).toBe(false);
    const entry = (await storage.auditLogs.listRecent()).find((e) => e.action === "membership.blocked");
    expect(entry?.metadata).toMatchObject({ until: until.toISOString() });

    vi.setSystemTime(new Date("2026-10-07T11:59:59Z"));
    expect(await engine.can(input)).toBe(false);
    expect(await storage.memberships.count({ organizationId: "org", status: "blocked" })).toBe(1);

    vi.setSystemTime(until);
    expect(await engine.can(input)).toBe(true);
    expect(await storage.memberships.findById("m-alice")).toMatchObject({ status: "active" });
    expect((await storage.memberships.findById("m-alice"))!.blocked).toBeUndefined();
    expect(await storage.memberships.count({ organizationId: "org", status: "blocked" })).toBe(0);
    expect(await storage.memberships.search({ organizationId: "org", status: "blocked" })).toEqual([]);
  });

  it("valida la fecha y no suspende al último Owner activo", async () => {
    const { storage } = await setup();
    await expect(storage.memberships.block("m-alice", { actor: admin, until: new Date(Date.now() - 1) })).rejects.toMatchObject({ code: "membership_block_until_invalid" });
    await expect(storage.memberships.block("m-alice", { actor: admin, until: new Date("x") })).rejects.toMatchObject({ code: "membership_block_until_invalid" });
    await expect(storage.memberships.block("m-bob", { actor: admin, until: new Date(Date.now() + 60_000) })).rejects.toMatchObject({ code: "last_owner" });
  });
});
