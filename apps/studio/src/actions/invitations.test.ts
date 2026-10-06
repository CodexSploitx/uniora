import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvitationError, type InvitationService } from "@uniora/core";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/i18n/server", () => ({
  getT: async () => ({ locale: "es", t: (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ""}` }),
}));
vi.mock("@/lib/env", () => ({ getStudioEnv: () => ({ operator: "tester" }) }));
vi.mock("@/lib/db", () => ({ getStorage: () => ({}) }));

const session = vi.hoisted(() => ({ requireWrite: vi.fn(async () => {}) }));
vi.mock("@/lib/session", async () => {
  class StudioAuthError extends Error {}
  class StudioReadOnlyError extends Error {}
  return { StudioAuthError, StudioReadOnlyError, requireWrite: session.requireWrite };
});

const setup = vi.hoisted(() => ({ value: { service: null as unknown, mail: "no-smtp" } }));
vi.mock("@/lib/invitations", () => ({ getInvitationSetup: async () => setup.value }));

import { inviteMember, resendInvitation, revokeInvitation } from "./invitations";

function fakeService(overrides: Partial<InvitationService> = {}): InvitationService {
  return {
    invite: vi.fn(async () => ({ acceptUrl: "https://app.test/invite/tok", delivery: { status: "skipped", attempts: 0 } })),
    resend: vi.fn(async () => ({ acceptUrl: "https://app.test/invite/new", delivery: { status: "sent", attempts: 1 } })),
    revoke: vi.fn(async () => ({})),
    preview: vi.fn(),
    accept: vi.fn(),
    ...overrides,
  } as unknown as InvitationService;
}

beforeEach(() => {
  session.requireWrite.mockReset();
  session.requireWrite.mockResolvedValue(undefined);
  setup.value = { service: fakeService(), mail: "no-smtp" };
});

describe("inviteMember", () => {
  it("invites as the Studio operator, in the viewer's language, and returns the link once", async () => {
    const service = setup.value.service as InvitationService;
    const result = await inviteMember({ organizationId: "org-1", email: " Ana@Example.com ", roleId: "role-1" });
    expect(result).toEqual({ ok: true, data: { acceptUrl: "https://app.test/invite/tok", delivery: "skipped", error: undefined } });
    expect(service.invite).toHaveBeenCalledWith({
      organizationId: "org-1",
      email: "Ana@Example.com",
      roleIds: ["role-1"],
      invitedBy: { provider: "uniora-studio", subject: "tester" },
      locale: "es",
    });
  });

  it("refuses without touching the service in read-only mode", async () => {
    const { StudioReadOnlyError } = await import("@/lib/session");
    session.requireWrite.mockRejectedValue(new StudioReadOnlyError());
    const service = setup.value.service as InvitationService;
    const result = await inviteMember({ organizationId: "org-1", email: "a@b.co", roleId: "r" });
    expect(result).toMatchObject({ ok: false, error: "errors.readOnly" });
    expect(service.invite).not.toHaveBeenCalled();
  });

  it("explains that UNIORA_INVITE_URL is missing when there is no service", async () => {
    setup.value = { service: null, mail: "no-smtp" };
    expect(await inviteMember({ organizationId: "org-1", email: "a@b.co", roleId: "r" })).toMatchObject({ ok: false, error: "errors.inviteUrlMissing" });
  });

  it("validates untrusted input before reaching the service", async () => {
    const service = setup.value.service as InvitationService;
    expect(await inviteMember({ organizationId: "org-1", email: "", roleId: "r" })).toMatchObject({ ok: false });
    expect(await inviteMember({ organizationId: "org-1", email: "a@b.co", roleId: 42 as unknown as string })).toMatchObject({ ok: false });
    expect(service.invite).not.toHaveBeenCalled();
  });

  it("shows core's own invitation errors verbatim, even when the class comes from another module copy", async () => {
    const lookalike = Object.assign(new Error("Too many invitations were sent recently. Try again later."), { name: "InvitationError" });
    setup.value = { service: fakeService({ invite: vi.fn(async () => Promise.reject(lookalike)) }), mail: "no-smtp" };
    expect(await inviteMember({ organizationId: "org-1", email: "a@b.co", roleId: "r" })).toEqual({ ok: false, error: lookalike.message });
    setup.value = { service: fakeService({ invite: vi.fn(async () => Promise.reject(new InvitationError("Owner not allowed", "bad_request"))) }), mail: "no-smtp" };
    expect(await inviteMember({ organizationId: "org-1", email: "a@b.co", roleId: "r" })).toEqual({ ok: false, error: "Owner not allowed" });
  });

  it("never leaks unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setup.value = { service: fakeService({ invite: vi.fn(async () => Promise.reject(new Error("connection string leaked: postgres://u:p@h"))) }), mail: "no-smtp" };
    expect(await inviteMember({ organizationId: "org-1", email: "a@b.co", roleId: "r" })).toEqual({ ok: false, error: "errors.unexpected" });
  });
});

describe("resendInvitation and revokeInvitation", () => {
  it("resend passes the organization with the invitation so a stranger's id can't be touched", async () => {
    const service = setup.value.service as InvitationService;
    const result = await resendInvitation({ organizationId: "org-1", invitationId: "inv-9" });
    expect(result).toMatchObject({ ok: true, data: { delivery: "sent" } });
    expect(service.resend).toHaveBeenCalledWith(
      { organizationId: "org-1", invitationId: "inv-9", actor: { provider: "uniora-studio", subject: "tester" } },
      { locale: "es" },
    );
  });

  it("revoke calls the service with the same scoping", async () => {
    const service = setup.value.service as InvitationService;
    expect(await revokeInvitation({ organizationId: "org-1", invitationId: "inv-9" })).toEqual({ ok: true });
    expect(service.revoke).toHaveBeenCalledWith({ organizationId: "org-1", invitationId: "inv-9", actor: { provider: "uniora-studio", subject: "tester" } });
  });
});
