import { describe, expect, it } from "vitest";
import { createTranslator } from "@/i18n/translate";
import { en } from "@/i18n/messages/en";
import { es } from "@/i18n/messages/es";
import { describeActivity, timeAgo } from "./format";
import type { ActivityItem } from "./types";

const tEn = createTranslator("en", en);
const tEs = createTranslator("es", es);

const base: ActivityItem = {
  id: "1",
  organizationId: "org",
  organizationName: "Acme",
  action: "role.created",
  actor: { provider: "uniora-studio", subject: "local-admin" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("timeAgo", () => {
  const now = new Date("2026-01-01T12:00:00.000Z").getTime();
  it("describes recent and older times in English", () => {
    expect(timeAgo("2026-01-01T11:59:50.000Z", "en", tEn, now)).toBe("just now");
    expect(timeAgo("2026-01-01T11:00:00.000Z", "en", tEn, now)).toBe("1 hour ago");
    expect(timeAgo("2025-12-30T12:00:00.000Z", "en", tEn, now)).toBe("2 days ago");
  });

  it("describes them in Spanish", () => {
    expect(timeAgo("2026-01-01T11:59:50.000Z", "es", tEs, now)).toBe("ahora mismo");
    expect(timeAgo("2026-01-01T11:00:00.000Z", "es", tEs, now)).toBe("hace 1 hora");
  });
});

describe("describeActivity", () => {
  it("phrases known actions in the viewer's language", () => {
    const item = { ...base, metadata: { name: "Sales" } };
    expect(describeActivity(item, tEn)).toMatchObject({ title: "Role created", detail: "Sales", tone: "success" });
    expect(describeActivity(item, tEs)).toMatchObject({ title: "Rol creado", detail: "Sales", tone: "success" });
    expect(describeActivity({ ...base, action: "role.deleted", metadata: { name: "Sales" } }, tEs).tone).toBe("destructive");
    expect(
      describeActivity({ ...base, action: "role.permission_revoked", metadata: { role: "Sales", permission: "vehicles.delete" } }, tEn),
    ).toMatchObject({ title: "Permission revoked", tone: "warning" });
  });

  it("falls back to the raw action for unknown ones", () => {
    expect(describeActivity({ ...base, action: "custom.thing", target: { type: "x", id: "y" } }, tEn)).toMatchObject({
      title: "custom.thing",
      detail: "x:y",
    });
  });
});
