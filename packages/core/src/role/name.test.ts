import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { normalizeRoleName } from "./key.js";

describe("normalizeRoleName", () => {
  it.each([
    ["Recepción", "recepcion"],
    ["  RECEPCIÓN ", "recepcion"],
    ["Re   cepción", "re cepcion"],
    ["Ñandú", "nandu"],
    ["Owner", "owner"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeRoleName(input)).toBe(expected);
  });

  it("rejects what sanitizeRoleName rejects", () => {
    expect(() => normalizeRoleName("   ")).toThrow();
  });
});

describe("role name uniqueness (memory backend)", () => {
  it("treats case, accents and spacing as the same name, per organization", async () => {
    const storage = createMemoryStorage();
    await storage.organizations.create({ id: "o1", name: "Uno" });
    await storage.organizations.create({ id: "o2", name: "Dos" });
    await storage.roles.create({ id: "a", organizationId: "o1", name: "Recepción" });
    await expect(storage.roles.create({ id: "b", organizationId: "o1", name: "recepcion", key: "b" })).rejects.toMatchObject({
      name: "RoleError",
    });
    await expect(storage.roles.create({ id: "c", organizationId: "o2", name: "recepcion", key: "c" })).resolves.toBeDefined();
    await expect(storage.roles.rename("a", "RECEPCIÓN")).resolves.toMatchObject({ name: "RECEPCIÓN" });
  });
});
