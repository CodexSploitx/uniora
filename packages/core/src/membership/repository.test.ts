import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { MembershipError } from "./repository.js";
import { createOrganizationWithOwner } from "../organization/create-with-owner.js";

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

  it("rechaza unassignOwnerRole del Owner role cuando es el único membership que lo tiene", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const owner = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const membership = await storage.memberships.create({
      id: "m-1",
      organizationId: "org-1",
      identity,
      roleIds: [owner.id],
    });

    await expect(storage.memberships.unassignOwnerRole(membership.id, owner.id)).rejects.toThrow(MembershipError);

    // No debe haber mutado nada.
    const found = await storage.memberships.findByIdentity("org-1", identity);
    expect(found?.roleIds).toEqual([owner.id]);
  });

  it("permite unassignOwnerRole del Owner role si otro membership también lo tiene", async () => {
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

    await expect(storage.memberships.unassignOwnerRole(membership1.id, owner.id)).resolves.toBeUndefined();
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

  it("un membership leído es una copia: mutarlo no puede forjar el Owner role de otra organización (INV-001)", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.create({ id: "org-2", name: "Other" });
    const ownerOrg2 = await storage.roles.createOwnerRole({ id: "role-owner-2", organizationId: "org-2" });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    // `create()`/`assignRole()` rechazan un roleId de otra organización desde el origen
    // (docs/security-pentest-2026-09-24.md Hallazgo 2), y el almacén en memoria devuelve
    // copias: ni siquiera mutando el objeto leído se puede fabricar ese estado.
    membership.roleIds.push(ownerOrg2.id);

    expect((await storage.memberships.findById(membership.id))!.roleIds).toEqual([]);
    await expect(storage.memberships.delete(membership.id)).resolves.toBeUndefined();
  });
});

describe("MembershipRepository — el role debe pertenecer a la misma organización (regresión — docs/security-pentest-2026-09-24.md Hallazgo 2)", () => {
  it("create() rechaza un roleId que pertenece a otra organización", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.create({ id: "org-2", name: "Other" });
    const roleOrg2 = await storage.roles.create({ id: "role-org-2", organizationId: "org-2", name: "Admin" });

    await expect(
      storage.memberships.create({ id: "m-1", organizationId: "org-1", identity, roleIds: [roleOrg2.id] }),
    ).rejects.toThrow(MembershipError);
    expect(await storage.memberships.findById("m-1")).toBeNull();
  });

  it("assignRole() rechaza un roleId que pertenece a otra organización", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.create({ id: "org-2", name: "Other" });
    const roleOrg2 = await storage.roles.create({ id: "role-org-2", organizationId: "org-2", name: "Admin" });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });

    await expect(storage.memberships.assignRole(membership.id, roleOrg2.id)).rejects.toThrow(MembershipError);
    expect((await storage.memberships.findById(membership.id))?.roleIds).toEqual([]);
  });

  it("assignRole() sigue funcionando normalmente cuando el role es de la misma organización", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const role = await storage.roles.create({ id: "role-org-1", organizationId: "org-1", name: "Sales" });
    const membership = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });

    await expect(storage.memberships.assignRole(membership.id, role.id)).resolves.toBeUndefined();
    expect((await storage.memberships.findById(membership.id))?.roleIds).toEqual([role.id]);
  });
});

describe("MembershipRepository.create() — identidad duplicada en la misma organización (regresión, docs/security-pentest-2026-09-24.md Ronda 6)", () => {
  it("rechaza crear un segundo membership para la misma identidad en la misma organización", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });

    await expect(storage.memberships.create({ id: "m-2-duplicate", organizationId: "org-1", identity })).rejects.toThrow(MembershipError);
  });

  it("permite la MISMA identidad en organizaciones DISTINTAS (no es una identidad global única)", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.create({ id: "org-2", name: "Beta" });
    await storage.memberships.create({ id: "m-org1", organizationId: "org-1", identity });

    await expect(storage.memberships.create({ id: "m-org2", organizationId: "org-2", identity })).resolves.toMatchObject({ organizationId: "org-2" });
  });

  it("permite identidades DISTINTAS en la misma organización", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });

    await expect(
      storage.memberships.create({ id: "m-2", organizationId: "org-1", identity: { provider: "supabase", subject: "user-2" } }),
    ).resolves.toMatchObject({ organizationId: "org-1" });
  });

  it("un membership eliminado libera la identidad para un nuevo membership en la misma organización", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const first = await storage.memberships.create({ id: "m-1", organizationId: "org-1", identity });
    await storage.memberships.delete(first.id);

    await expect(storage.memberships.create({ id: "m-2", organizationId: "org-1", identity })).resolves.toMatchObject({ organizationId: "org-1" });
  });

  it("un duplicado nunca puede dejar el Owner role 'atrapado' en una fila inalcanzable (impacto real del hallazgo)", async () => {
    const storage = createMemoryStorage();
    const ownerIdentity = { provider: "supabase", subject: "owner-1" };
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    const ownerRole = await storage.roles.createOwnerRole({ id: "role-owner", organizationId: "org-1" });
    const first = await storage.memberships.create({ id: "m-owner-1", organizationId: "org-1", identity: ownerIdentity, roleIds: [ownerRole.id] });

    // Antes del fix, esto creaba un segundo membership para la MISMA
    // identidad, inflando artificialmente el conteo de Owners y permitiendo
    // quitarle el Owner role al membership realmente alcanzable
    // (findByIdentity siempre resuelve al primero insertado) mientras el
    // duplicado — inalcanzable — lo conservaba.
    await expect(
      storage.memberships.create({ id: "m-owner-2-duplicate", organizationId: "org-1", identity: ownerIdentity, roleIds: [ownerRole.id] }),
    ).rejects.toThrow(MembershipError);

    // Como el duplicado nunca se crea, `unassignOwnerRole` sobre el único
    // membership real sigue protegido por la regla normal de último-Owner.
    await expect(storage.memberships.unassignOwnerRole(first.id, ownerRole.id)).rejects.toThrow(MembershipError);
  });
});

describe("MembershipRepository.create() — boundary collapse vía identity link inverso (regresión, docs/security-pentest-2026-09-24.md Ronda 7)", () => {
  const actor = { provider: "supabase", subject: "actor-owner" };
  const y = { provider: "legacy", subject: "y" };
  const x = { provider: "new-provider", subject: "x" };

  it("rechaza crear un membership directo para una identidad que ya es 'from' de un link (mismo invariante que link() ya afirma)", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.memberships.create({ id: "m-y", organizationId: "org-1", identity: y });
    await storage.identityLinks.link({ from: x, to: y, actor });

    // `link()` ya rechaza esto en la dirección opuesta ("from ya tiene
    // membership directo") — antes de este fix, create() no aplicaba el
    // mismo invariante, permitiendo construir el estado exacto que link()
    // llama "ambiguous/hijackable lookup" simplemente invirtiendo el orden.
    await expect(
      storage.memberships.create({ id: "m-x", organizationId: "org-1", identity: x, roleIds: [] }),
    ).rejects.toThrow(MembershipError);
  });

  it("una identidad NO linkeada puede crear su membership directo normalmente (no es una regresión general)", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await expect(
      storage.memberships.create({ id: "m-x", organizationId: "org-1", identity: x, roleIds: [] }),
    ).resolves.toMatchObject({ organizationId: "org-1" });
  });

  it("el bloqueo aplica en CUALQUIER organización, no solo en la de 'to' (mismo alcance que el propio guard de link())", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.create({ id: "org-2", name: "Wayne Ent." });
    await storage.memberships.create({ id: "m-y", organizationId: "org-1", identity: y });
    await storage.identityLinks.link({ from: x, to: y, actor });

    await expect(
      storage.memberships.create({ id: "m-x-org2", organizationId: "org-2", identity: x, roleIds: [] }),
    ).rejects.toThrow(MembershipError);
  });

  it("la identidad 'to' de un link puede seguir teniendo sus propios memberships adicionales sin restricción", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "org-1", name: "Acme" });
    await storage.organizations.create({ id: "org-2", name: "Wayne Ent." });
    await storage.memberships.create({ id: "m-y-1", organizationId: "org-1", identity: y });
    await storage.identityLinks.link({ from: x, to: y, actor });

    await expect(
      storage.memberships.create({ id: "m-y-2", organizationId: "org-2", identity: y, roleIds: [] }),
    ).resolves.toMatchObject({ organizationId: "org-2" });
  });
});

describe("MembershipRepository.delete — stable error codes", () => {
  it("el último Owner da last_owner y un id desconocido membership_not_found", async () => {
    const storage = createMemoryStorage();
    const { membership, ownerRole } = await createOrganizationWithOwner(storage, {
      organizationId: "org-1",
      organizationName: "Acme",
      ownerRoleId: "role-owner",
      membershipId: "m-1",
      ownerIdentity: identity,
    });

    await expect(storage.memberships.delete(membership.id)).rejects.toMatchObject({ code: "last_owner" });
    await expect(storage.memberships.unassignOwnerRole(membership.id, ownerRole.id)).rejects.toMatchObject({ code: "last_owner" });
    await expect(storage.memberships.delete("nope")).rejects.toMatchObject({ code: "membership_not_found" });
  });
});
