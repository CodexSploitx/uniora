import { describe, expect, it } from "vitest";
import { createAuthorizationEngine } from "../authorization/engine.js";
import { createOrganizationWithOwner } from "../index.js";
import { createMemoryStorage } from "../storage/memory.js";
import { grantStatus } from "./repository.js";

const ops = { provider: "p", subject: "ops" };
const owner = { provider: "p", subject: "owner" };
const inHours = (hours: number) => new Date(Date.now() + hours * 3600 * 1000);

async function seed() {
  const storage = createMemoryStorage();
  await createOrganizationWithOwner(storage, { organizationId: "org-1", organizationName: "Acme", ownerRoleId: "r-owner", membershipId: "m-owner", ownerIdentity: owner });
  for (const key of ["reports.read", "reports.write", "billing.read"]) await storage.permissions.register({ key });
  await storage.permissions.register({ key: "reports.admin", implies: ["reports.write"] });
  return storage;
}

describe("support grants (memory)", () => {
  it("validates, then lets a non-member do exactly what the grant lists, on that organization only", async () => {
    const storage = await seed();
    const base = { id: "g1", organizationId: "org-1", operator: ops, grantedBy: owner, reason: "ticket 1", permissions: ["reports.admin"], expiresAt: inHours(1) };
    await expect(storage.supportGrants.create({ ...base, reason: "" })).rejects.toMatchObject({ code: "support_grant_reason_invalid" });
    await expect(storage.supportGrants.create({ ...base, permissions: ["never.registered"] })).rejects.toMatchObject({ code: "support_grant_permission_invalid" });
    await expect(storage.supportGrants.create({ ...base, expiresAt: inHours(24 * 31) })).rejects.toMatchObject({ code: "support_grant_expiry_invalid" });
    await expect(storage.supportGrants.create({ ...base, organizationId: "ghost" })).rejects.toMatchObject({ code: "support_grant_organization_unknown" });
    const engine = createAuthorizationEngine(storage);
    const can = (permission: string) => engine.can({ identity: ops, organizationId: "org-1", permission });
    expect(await can("reports.write")).toBe(false);
    await storage.supportGrants.create(base);
    expect(await can("reports.admin")).toBe(true);
    expect(await can("reports.write")).toBe(true);
    expect(await can("reports.read")).toBe(false);
    expect(await can("anything.at_all")).toBe(false);
    expect(await engine.access.check({ identity: ops, organizationId: "org-1" })).toBe(true);
    await expect(storage.supportGrants.create(base)).rejects.toMatchObject({ code: "support_grant_exists" });
  });

  it("revoking ends it, a suspended organization denies it and the decision says how it was allowed", async () => {
    const storage = await seed();
    const decisions: Array<{ allowed: boolean; via?: string }> = [];
    const engine = createAuthorizationEngine(storage, { onDecision: (decision) => void decisions.push(decision) });
    await storage.supportGrants.create({ id: "g1", organizationId: "org-1", operator: ops, grantedBy: owner, reason: "r", permissions: ["reports.read"], expiresAt: inHours(1) });
    expect(await engine.can({ identity: ops, organizationId: "org-1", permission: "reports.read" })).toBe(true);
    expect(await engine.can({ identity: owner, organizationId: "org-1", permission: "reports.read" })).toBe(true);
    expect(decisions.map((decision) => decision.via)).toEqual(["support_grant", "membership"]);
    await storage.organizations.setStatus("org-1", { status: "suspended", actor: owner });
    expect(await engine.can({ identity: ops, organizationId: "org-1", permission: "reports.read" })).toBe(false);
    await storage.organizations.setStatus("org-1", { status: "active", actor: owner });
    await storage.supportGrants.revoke("g1", { by: owner });
    expect(await engine.can({ identity: ops, organizationId: "org-1", permission: "reports.read" })).toBe(false);
    const revoked = await storage.supportGrants.findById("g1");
    expect(grantStatus(revoked!, new Date())).toBe("revoked");
    expect(await storage.supportGrants.count({ status: "revoked" })).toBe(1);
  });
});
