import { describe, expect, it } from "vitest";
import { ApiCredentialError, createApiCredentialService, createMemoryApiCredentialStorage, normalizeApiClientName, sanitizeApiClientName } from "../index.js";

describe("API client names", () => {
  it("refuse control, zero-width and bidirectional characters", () => {
    for (const bad of ["evil‮gnp.exe", "bill​ing", "a b", "a⁦b", "a\u0085b", "a\u0007b", "a﻿b", "a­b"]) {
      expect(() => sanitizeApiClientName(bad), JSON.stringify(bad)).toThrow(ApiCredentialError);
    }
    expect(sanitizeApiClientName("  billing   service  ")).toBe("billing service");
    expect(sanitizeApiClientName("Facturación ñ 請求")).toBe("Facturación ñ 請求");
  });

  it("are unique after compatibility folding, so a look-alike is the same name", async () => {
    expect(normalizeApiClientName("Ｂilling")).toBe(normalizeApiClientName("billing"));
    const service = createApiCredentialService({ storage: createMemoryApiCredentialStorage() });
    const actor = { provider: "uniora-cli", subject: "t" };
    await service.createClient({ actor, name: "billing", scopes: ["check"], organizations: "*" });
    await expect(service.createClient({ actor, name: "ＢＩＬＬＩＮＧ", scopes: ["check"], organizations: "*" })).rejects.toMatchObject({ code: "api_client_exists" });
  });
});
