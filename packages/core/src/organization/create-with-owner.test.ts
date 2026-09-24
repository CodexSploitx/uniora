import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { createAuthorizationEngine } from "../authorization/engine.js";
import { createOrganizationWithOwner } from "./create-with-owner.js";

describe("createOrganizationWithOwner", () => {
  const ownerIdentity = { provider: "supabase", subject: "user-1" };

  it("crea la organización, su Owner role y la membership fundadora en un solo paso", async () => {
    const storage = createMemoryStorage();

    const { organization, ownerRole, membership } = await createOrganizationWithOwner(storage, {
      organizationId: "org-1",
      organizationName: "Acme Motors",
      ownerRoleId: "role-owner",
      membershipId: "m-1",
      ownerIdentity,
    });

    expect(organization).toMatchObject({ id: "org-1", name: "Acme Motors" });
    expect(ownerRole).toMatchObject({ isOwnerRole: true, name: "Owner", organizationId: "org-1" });
    expect(membership).toMatchObject({ organizationId: "org-1", identity: ownerIdentity, roleIds: [ownerRole.id] });
  });

  it("el creador queda con acceso total inmediatamente vía el AuthorizationEngine", async () => {
    const storage = createMemoryStorage();
    await createOrganizationWithOwner(storage, {
      organizationId: "org-1",
      organizationName: "Acme Motors",
      ownerRoleId: "role-owner",
      membershipId: "m-1",
      ownerIdentity,
    });

    const engine = createAuthorizationEngine(storage);
    expect(await engine.can({ identity: ownerIdentity, organizationId: "org-1", permission: "vehicles.delete" })).toBe(
      true,
    );
  });

  it("nunca produce un segundo Owner role para la misma organización (falla en el paso de rol, no en el de la org)", async () => {
    const storage = createMemoryStorage();
    await createOrganizationWithOwner(storage, {
      organizationId: "org-1",
      organizationName: "Acme Motors",
      ownerRoleId: "role-owner-1",
      membershipId: "m-1",
      ownerIdentity,
    });

    // Reintentar sobre el mismo organizationId debe fallar en el paso de
    // `createOwnerRole` (ya existe un Owner role para "org-1") en vez de
    // dejar un segundo Owner role colgando. Se usa un nombre distinto para
    // que el paso de creación de la organización en sí no falle antes por
    // colisión de slug (`organizations.create` overwrites por id en
    // memoria, así que sí llega a intentar `createOwnerRole`). El rollback
    // real de la transacción está cubierto contra Postgres en
    // @uniora/postgres (storage.test.ts), donde `storage.transaction` sí
    // ofrece atomicidad real — la memoria la documenta como no-op (ver
    // storage/memory.ts).
    await expect(
      createOrganizationWithOwner(storage, {
        organizationId: "org-1",
        organizationName: "Acme Motors Renamed",
        ownerRoleId: "role-owner-2",
        membershipId: "m-2",
        ownerIdentity,
      }),
    ).rejects.toThrow(/already has an Owner role/);

    const ownerRoles = (await storage.roles.listByOrganization("org-1")).filter((r) => r.isOwnerRole);
    expect(ownerRoles).toHaveLength(1);
  });
});
