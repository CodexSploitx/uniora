import { describe, expect, it } from "vitest";
import type { InvitationMessage } from "@uniora/core";
import { renderInvitationEmail } from "./templates.js";
import { resolveLocale, STRINGS } from "./locales.js";

const message: InvitationMessage = {
  invitationId: "inv-1",
  to: "ana@example.com",
  organization: { id: "org-1", name: "Acme Motors", slug: "acme-motors" },
  roleNames: ["Editor", "Viewer"],
  invitedBy: { provider: "supabase", subject: "u1" },
  acceptUrl: "https://app.test/invite/uinv_abc-123",
  expiresAt: new Date("2026-10-13T12:00:00Z"),
};

describe("renderInvitationEmail", () => {
  it("renders subject, HTML and a plain-text alternative carrying the link", () => {
    const email = renderInvitationEmail(message, { inviterName: "Ana Pérez", brandName: "Acme", supportEmail: "help@acme.com" });
    expect(email.subject).toBe("You're invited to join Acme Motors");
    expect(email.html).toContain('href="https://app.test/invite/uinv_abc-123"');
    expect(email.html).toContain("<strong>Ana Pérez</strong>");
    expect(email.html).toContain("Editor · Viewer");
    expect(email.html).toContain("prefers-color-scheme:dark");
    expect(email.html).toContain("help@acme.com");
    expect(email.text).toContain("Accept invitation: https://app.test/invite/uinv_abc-123");
    expect(email.text).toContain("Your roles: Editor, Viewer");
    expect(email.text).toContain("October 13, 2026");
    expect(email.text).not.toMatch(/<[a-z]/);
  });

  it("localizes (with region fallback) and defaults to English", () => {
    expect(renderInvitationEmail({ ...message, locale: "es-MX" }).subject).toBe("Te invitaron a unirte a Acme Motors");
    expect(renderInvitationEmail({ ...message, locale: "de" }).html).toContain('lang="de"');
    expect(renderInvitationEmail({ ...message, locale: "xx" }).subject).toBe("You're invited to join Acme Motors");
    expect(renderInvitationEmail({ ...message, locale: "xx" }, { defaultLocale: "fr" }).subject).toContain("rejoindre");
    expect(resolveLocale("PT_br")).toBe("pt");
  });

  it("every locale defines every string", () => {
    const keys = Object.keys(STRINGS.en).sort();
    for (const [locale, strings] of Object.entries(STRINGS)) expect(Object.keys(strings).sort(), locale).toEqual(keys);
  });

  it("escapes hostile organization, role and inviter names", () => {
    const hostile = '<img src=x onerror=alert(1)>"&\'$&';
    const email = renderInvitationEmail(
      { ...message, organization: { ...message.organization, name: hostile }, roleNames: [hostile] },
      { inviterName: hostile, brandName: hostile },
    );
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("keeps the Subject on one line", () => {
    const email = renderInvitationEmail({ ...message, organization: { ...message.organization, name: "Acme\r\nBcc: evil@x.com" } });
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it("refuses non-http(s) links and non-https logos, and ignores a malformed brand color", () => {
    expect(() => renderInvitationEmail({ ...message, acceptUrl: "javascript:alert(1)" })).toThrow(/http/);
    expect(() => renderInvitationEmail(message, { logoUrl: "http://x.test/logo.png" })).toThrow(/https/);
    const email = renderInvitationEmail(message, { brandColor: "red;background:url(x)" });
    expect(email.html).toContain("#4f46e5");
    expect(email.html).not.toContain("url(x)");
  });

  it("picks a readable button text color for light and dark brand colors", () => {
    expect(renderInvitationEmail(message, { brandColor: "#fde047" }).html).toContain("background:#fde047;color:#111827");
    expect(renderInvitationEmail(message, { brandColor: "#1e3a8a" }).html).toContain("background:#1e3a8a;color:#ffffff");
  });

  it("uses a single-role label for one role and omits the block for none", () => {
    expect(renderInvitationEmail({ ...message, roleNames: ["Editor"] }).text).toContain("Your role: Editor");
    expect(renderInvitationEmail({ ...message, roleNames: [] }).text).not.toContain("Your role");
  });
});
