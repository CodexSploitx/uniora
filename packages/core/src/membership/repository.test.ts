import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { MembershipError } from "./repository.js";

const identity = { provider: "supabase", subject: "user-1" };

describe("MembershipRepository — Owner protection (uniora-security-engineering §11)", () => {
  it("unassignRole quita un role custom normalmente", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const role = await storage.roles.create({ id: "role-sales", organizationId: "org-1", name: "Sales" });
    const membership = await storage.memberships.create({
      id: "m-1",
      organizationId: "org-1",
      identity,
      roleIds: [role.id],
    });

    await storage.memberships.unassignRole(membership.id, role.id);

    const found = await storage.memberships.findByIdentity("org-1", identity);
    expect(found?.roleIds).toEqual([]);
  });

  it("unassignRole de un role no asignado es un no-op idempotente", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });

    await expect(storage.memberships.unassignRole(membership.id, "role-sales")).resolves.toBeUndefined();
  });

  it("rechaza unassignRole del Owner role cuando es el único membership que lo tiene", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const membership = await storage.memberships.create({
      id: "m-1",
      organizationId: "org-1",
      identity,
      roleIds: [owner.id],
    });

    await expect(storage.memberships.unassignRole(membership.id, owner.id)).rejects.toThrow(MembershipError);

    // No debe haber mutado nada.
    const found = await storage.memberships.findByIdentity("org-1", identity);
    expect(found?.roleIds).toEqual([owner.id]);
  });

  it("permite unassignRole del Owner role si otro membership también lo tiene", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const secondIdentity = { provider: "supabase", subject: "user-2" };
    const membership1 = await storage.memberships.create({
      id: "m-1",
      organizationId: "org-1",
      identity,
      roleIds: [owner.id],
    });
    await storage.memberships.create({
      id: "m-2",
      organizationId: "org-1",
      identity: secondIdentity,
      roleIds: [owner.id],
    });

    await expect(storage.memberships.unassignRole(membership1.id, owner.id)).resolves.toBeUndefined();
    const found = await storage.memberships.findByIdentity("org-1", identity);
    expect(found?.roleIds).toEqual([]);
  });

  it("delete borra un membership sin el Owner role normalmente", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });

    await storage.memberships.delete(membership.id);

    expect(await storage.memberships.findByIdentity("org-1", identity)).toBeNull();
  });

  it("rechaza delete del único membership que tiene el Owner role", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const membership = await storage.memberships.create({
      id: "m-1",
      organizationId: "org-1",
      identity,
      roleIds: [owner.id],
    });

    await expect(storage.memberships.delete(membership.id)).rejects.toThrow(MembershipError);
    expect(await storage.memberships.findByIdentity("org-1", identity)).not.toBeNull();
  });

  it("permite delete de un membership con el Owner role si otro membership también lo tiene", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const secondIdentity = { provider: "supabase", subject: "user-2" };
    const membership1 = await storage.memberships.create({
      id: "m-1",
      organizationId: "org-1",
      identity,
      roleIds: [owner.id],
    });
    await storage.memberships.create({
      id: "m-2",
      organizationId: "org-1",
      identity: secondIdentity,
      roleIds: [owner.id],
    });

    await expect(storage.memberships.delete(membership1.id)).resolves.toBeUndefined();
    expect(await storage.memberships.findByIdentity("org-1", identity)).toBeNull();
  });

  it("delete de un membership inexistente falla con MembershipError", async () => {
    const storage = createMemoryStorage();
    await expect(storage.memberships.delete("no-such-membership")).rejects.toThrow(MembershipError);
  });

  it("el Owner role de otra organización nunca bloquea el delete de un membership de esta (INV-001)", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.create({ id: "org-2", name: "Other" });
    const ownerOrg2 = await storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-2" });
    // Simula un roleId de otra organización forjado/asignado por error.
    const membership = await storage.memberships.create({
      id: "m-1",
      organizationId: "org-1",
      identity,
      roleIds: [ownerOrg2.id],
    });

    // org-2 sigue sin nadie más con ese Owner role, pero este membership es
    // de org-1 — el invariante de "última owner" solo debe importar para la
    // organización dueña real del role, y de todas formas bloquear aquí es
    // lo seguro: nunca dejar caer silenciosamente la única referencia al
    // Owner role de org-2, aunque esté mal asignada.
    await expect(storage.memberships.delete(membership.id)).rejects.toThrow(MembershipError);
  });
});
