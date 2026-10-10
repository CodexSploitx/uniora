import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, createApiCredentialService, createMemoryApiCredentialStorage } from "../index.js";

describe("API credential audit entries", () => {
  it("use only catalogued action names, name the operator and never carry a secret", async () => {
    const storage = createMemoryApiCredentialStorage();
    const service = createApiCredentialService({ storage });
    const actor = { provider: "uniora-cli", subject: "ops" };
    const client = await service.createClient({ actor, name: "billing", scopes: ["check"], organizations: "*" });
    await service.updateClient({ actor, clientId: client.id, name: "billing-2" });
    const { key, token } = await service.createKey({ actor, clientId: client.id });
    await service.revokeKey({ actor, keyId: key.id });
    await service.disableClient({ actor, clientId: client.id });
    await service.enableClient({ actor, clientId: client.id });

    const entries = await storage.auditLogs.search();
    expect(new Set(entries.map((entry) => entry.action))).toEqual(
      new Set(["api_client.created", "api_client.updated", "api_key.created", "api_key.revoked", "api_client.disabled", "api_client.enabled"]),
    );
    for (const entry of entries) {
      expect(AUDIT_ACTIONS).toContain(entry.action);
      expect(entry.actor).toEqual(actor);
    }
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.split("_")[3] ?? "no-secret");
  });
});
