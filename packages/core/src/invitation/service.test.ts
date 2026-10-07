import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../storage/memory.js";
import { createOrganizationWithOwner } from "../organization/create-with-owner.js";
import { InvitationDeliveryError, sanitizeDeliveryError, type InvitationMessage, type InvitationSender } from "./delivery.js";
import { InvitationError } from "./repository.js";
import { createInvitationService, normalizeInvitationEmail, type InvitationServiceOptions } from "./service.js";
import { hashInvitationToken } from "./token.js";

const owner = { provider: "supabase", subject: "owner-1" };
const invitee = { provider: "supabase", subject: "invitee-1" };

async function setup(overrides: Partial<InvitationServiceOptions> = {}) {
  const storage = createMemoryStorage();
  await createOrganizationWithOwner(storage, {
    organizationId: "org-1",
    organizationName: "Acme Motors",
    ownerRoleId: "role-owner",
    membershipId: "m-owner",
    ownerIdentity: owner,
  });
  await storage.roles.create({ id: "role-editor", organizationId: "org-1", name: "Editor", permissionKeys: ["posts.edit"] });
  await storage.roles.create({ id: "role-viewer", organizationId: "org-1", name: "Viewer", permissionKeys: [] });

  const sent: InvitationMessage[] = [];
  const sender: InvitationSender = { send: async (message) => void sent.push(message) };
  const clock = { time: new Date("2026-10-06T12:00:00Z").getTime() };
  let counter = 0;
  const service = createInvitationService({
    storage,
    sender,
    acceptUrl: (token) => `https://app.test/invite/${token}`,
    now: () => new Date(clock.time),
    generateId: () => `id-${++counter}`,
    sleep: async () => {},
    random: () => 1,
    ...overrides,
  });
  return { storage, service, sent, clock };
}

const tokenOf = (url: string) => url.split("/invite/")[1]!;

describe("normalizeInvitationEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeInvitationEmail("  Ana@Example.COM ")).toBe("ana@example.com");
  });
  it.each(["", "no-at", "a@b", "a b@c.com", "a@b.com, c@d.com", "<x>@y.com", `${"a".repeat(65)}@x.com`])("rejects %j", (bad) => {
    expect(() => normalizeInvitationEmail(bad)).toThrow(InvitationError);
  });
});

describe("invite", () => {
  it("creates a pending invitation, stores only the token hash and sends the link", async () => {
    const { service, sent, storage } = await setup();
    const result = await service.invite({ organizationId: "org-1", email: "Ana@Example.com", roleIds: ["role-editor"], invitedBy: owner, locale: "es" });

    expect(result.invitation).toMatchObject({ email: "ana@example.com", status: "pending", roleIds: ["role-editor"] });
    expect(result.delivery).toEqual({ status: "sent", attempts: 1, error: undefined });
    expect(result.invitation.delivery.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "ana@example.com", roleNames: ["Editor"], locale: "es", organization: { name: "Acme Motors" } });
    expect(sent[0]!.acceptUrl).toBe(result.acceptUrl);

    const token = tokenOf(result.acceptUrl);
    expect(token).toMatch(/^uinv_[A-Za-z0-9_-]{43}$/);
    const stored = await storage.invitations.findByTokenHash(await hashInvitationToken(token));
    expect(stored?.id).toBe(result.invitation.id);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("audits creation without leaking the token", async () => {
    const { service, storage } = await setup();
    const { acceptUrl } = await service.invite({ organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner });
    const log = await storage.auditLogs.listByOrganization("org-1");
    expect(log.map((e) => e.action)).toContain("invitation.created");
    expect(JSON.stringify(log)).not.toContain(tokenOf(acceptUrl));
  });

  it("refuses the Owner role, foreign roles, empty role lists and unknown organizations", async () => {
    const { service, storage } = await setup();
    await createOrganizationWithOwner(storage, {
      organizationId: "org-2", organizationName: "Other", ownerRoleId: "role-owner-2", membershipId: "m-2", ownerIdentity: { provider: "x", subject: "y" },
    });
    const base = { organizationId: "org-1", email: "a@b.co", invitedBy: owner };
    await expect(service.invite({ ...base, roleIds: ["role-owner"] })).rejects.toThrow(/Owner role/);
    await expect(service.invite({ ...base, roleIds: ["role-owner-2"] })).rejects.toThrow(InvitationError);
    await expect(service.invite({ ...base, roleIds: [] })).rejects.toThrow(/at least one role/);
    await expect(service.invite({ ...base, organizationId: "nope", roleIds: ["role-editor"] })).rejects.toThrow(InvitationError);
  });

  it("rejects a second pending invitation for the same e-mail but allows one after the first expired", async () => {
    const { service, clock } = await setup({ ttlMs: 1000 });
    const input = { organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner };
    await service.invite(input);
    await expect(service.invite(input)).rejects.toMatchObject({ reason: "duplicate_pending" });
    clock.time += 2000;
    await expect(service.invite(input)).resolves.toBeDefined();
  });

  it("rate-limits per e-mail, and the window slides", async () => {
    const { service, clock } = await setup({ rateLimits: { perEmailPerHour: 2 } });
    const input = { organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner };
    for (let n = 0; n < 2; n++) {
      const { invitation } = await service.invite(input);
      await service.revoke({ organizationId: "org-1", invitationId: invitation.id, actor: owner });
    }
    await expect(service.invite(input)).rejects.toMatchObject({ reason: "rate_limited" });
    clock.time += 61 * 60 * 1000;
    await expect(service.invite(input)).resolves.toBeDefined();
  });

  it("without a sender, still creates the invitation and returns the link", async () => {
    const { service } = await setup({ sender: undefined });
    const result = await service.invite({ organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner });
    expect(result.delivery.status).toBe("skipped");
    expect(result.acceptUrl).toContain("/invite/uinv_");
  });
});

describe("invite — per-invitation lifetime", () => {
  const input = { organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner };
  const HOUR = 3_600_000;

  it("ttlMs on invite() overrides the service default, capped at 30 days; resend takes its own or the default", async () => {
    const { service, clock } = await setup();
    const short = await service.invite({ ...input, ttlMs: 24 * HOUR });
    expect(short.invitation.expiresAt.getTime()).toBe(clock.time + 24 * HOUR);
    const long = await service.invite({ ...input, email: "c@d.co", ttlMs: 999 * 24 * HOUR });
    expect(long.invitation.expiresAt.getTime()).toBe(clock.time + 30 * 24 * HOUR);
    const dflt = await service.invite({ ...input, email: "e@f.co" });
    expect(dflt.invitation.expiresAt.getTime()).toBe(clock.time + 7 * 24 * HOUR);

    clock.time += 2 * 60_000; // past the resend cooldown
    const again = await service.resend({ organizationId: "org-1", invitationId: short.invitation.id, actor: owner }, { ttlMs: 2 * HOUR });
    expect(again.invitation.expiresAt.getTime()).toBe(clock.time + 2 * HOUR);
    const plain = await service.resend({ organizationId: "org-1", invitationId: dflt.invitation.id, actor: owner });
    expect(plain.invitation.expiresAt.getTime()).toBe(clock.time + 7 * 24 * HOUR);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("rejects ttlMs %s", async (ttlMs) => {
    const { service } = await setup();
    await expect(service.invite({ ...input, ttlMs })).rejects.toMatchObject({ reason: "bad_request" });
  });
});

describe("invite — already a member", () => {
  const input = { organizationId: "org-1", email: "Ana@Example.com", roleIds: ["role-editor"], invitedBy: owner };

  it("refuses an address that belongs to a member, with the stable invitation_already_member code", async () => {
    const lookup = vi.fn(async (email: string) => (email === "ana@example.com" ? [invitee] : []));
    const { service, storage } = await setup({ findIdentitiesByEmail: lookup });
    await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: invitee });

    await expect(service.invite(input)).rejects.toMatchObject({ reason: "already_member", code: "invitation_already_member" });
    expect(lookup).toHaveBeenCalledWith("ana@example.com");
    expect(await storage.invitations.count("org-1")).toBe(0);
  });

  it("invites an address whose identity is not a member of THIS organization, or one nobody knows", async () => {
    const { service, storage } = await setup({ findIdentitiesByEmail: async (email) => (email === "ana@example.com" ? [invitee] : []) });
    await expect(service.invite(input)).resolves.toBeDefined(); // known to the host, but not a member here
    await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: invitee });
    await expect(service.invite({ ...input, email: "other@example.com" })).resolves.toBeDefined();
  });

  it("allowExistingMember keeps the 'gain roles on accept' flow, and without a lookup nothing changes", async () => {
    const { service, storage } = await setup({ findIdentitiesByEmail: async () => [invitee] });
    await storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: invitee });
    await expect(service.invite({ ...input, allowExistingMember: true })).resolves.toBeDefined();

    const plain = await setup();
    await plain.storage.memberships.create({ id: "m-ana", organizationId: "org-1", identity: invitee });
    await expect(plain.service.invite(input)).resolves.toBeDefined();
  });
});

describe("invitations.search / count (memory)", () => {
  it("filters by e-mail substring and status, and counts the same set", async () => {
    const { service, storage } = await setup();
    for (const email of ["ana@example.com", "anabel@corp.io", "bob@example.com"]) {
      await service.invite({ organizationId: "org-1", email, roleIds: ["role-editor"], invitedBy: owner });
    }
    expect(await storage.invitations.count("org-1")).toBe(3);
    expect(await storage.invitations.count("org-1", { query: "ANA" })).toBe(2);
    expect(await storage.invitations.count("org-1", { query: "ana", status: "revoked" })).toBe(0);
    expect((await storage.invitations.search("org-1", { query: "example.com" })).map((i) => i.email).sort()).toEqual(["ana@example.com", "bob@example.com"]);
  });
});

describe("delivery engine", () => {
  it("retries transient failures with backoff and then succeeds", async () => {
    const send = vi.fn<InvitationSender["send"]>().mockRejectedValueOnce(new Error("ECONNRESET")).mockRejectedValueOnce(new Error("timeout")).mockResolvedValue();
    const sleep = vi.fn(async () => {});
    const { service } = await setup({ sender: { send }, sleep, retry: { baseDelayMs: 100 }, random: () => 1 });
    const result = await service.invite({ organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner });
    expect(send).toHaveBeenCalledTimes(3);
    expect(result.delivery).toMatchObject({ status: "sent", attempts: 3 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("does not retry permanent failures, and a failure never throws out of invite()", async () => {
    const send = vi.fn<InvitationSender["send"]>().mockRejectedValue(new InvitationDeliveryError("550 mailbox unavailable", true));
    const { service, storage } = await setup({ sender: { send } });
    const result = await service.invite({ organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.delivery).toMatchObject({ status: "failed", attempts: 1 });
    expect(result.delivery.error).toContain("550 mailbox unavailable");
    expect(result.invitation.delivery).toMatchObject({ status: "failed", attempts: 1 });
    expect((await storage.auditLogs.listByOrganization("org-1")).map((e) => e.action)).toContain("invitation.delivery_failed");
  });

  it("gives up after maxAttempts and times out hung attempts", async () => {
    const send = vi.fn<InvitationSender["send"]>().mockImplementation(({ }, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const { service } = await setup({ sender: { send }, retry: { maxAttempts: 2, attemptTimeoutMs: 10 } });
    const result = await service.invite({ organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner });
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.delivery).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("scrubs the token and link out of recorded errors", async () => {
    const send = vi.fn<InvitationSender["send"]>().mockImplementation(async (message) => {
      throw new InvitationDeliveryError(`failed for ${message.acceptUrl}\nline2`, true);
    });
    const { service } = await setup({ sender: { send } });
    const result = await service.invite({ organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner });
    expect(result.delivery.error).not.toContain("uinv_");
    expect(result.delivery.error).not.toContain("\n");
    expect(sanitizeDeliveryError(new Error("x".repeat(900)), [])).toHaveLength(500);
  });
});

describe("resend and revoke", () => {
  it("resend issues a new link, kills the old one, and honours the cooldown", async () => {
    const { service, clock, sent } = await setup();
    const first = await service.invite({ organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner });
    await expect(service.resend({ organizationId: "org-1", invitationId: first.invitation.id, actor: owner })).rejects.toMatchObject({ reason: "cooldown" });
    clock.time += 120_000;
    const second = await service.resend({ organizationId: "org-1", invitationId: first.invitation.id, actor: owner });
    expect(sent).toHaveLength(2);
    expect(second.acceptUrl).not.toBe(first.acceptUrl);
    expect(second.invitation.delivery.sends).toBe(2);
    expect(await service.preview(tokenOf(first.acceptUrl))).toBeNull();
    expect(await service.preview(tokenOf(second.acceptUrl))).not.toBeNull();
  });

  it("revoke makes the link unusable and can't be applied twice", async () => {
    const { service } = await setup();
    const { invitation, acceptUrl } = await service.invite({ organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner });
    await service.revoke({ organizationId: "org-1", invitationId: invitation.id, actor: owner });
    expect(await service.preview(tokenOf(acceptUrl))).toBeNull();
    await expect(service.accept({ token: tokenOf(acceptUrl), identity: invitee, verifiedEmail: "a@b.co" })).rejects.toMatchObject({ reason: "revoked" });
    await expect(service.revoke({ organizationId: "org-1", invitationId: invitation.id, actor: owner })).rejects.toThrow(InvitationError);
  });
});

describe("accept", () => {
  async function invited(overrides: Partial<InvitationServiceOptions> = {}) {
    const ctx = await setup(overrides);
    const result = await ctx.service.invite({ organizationId: "org-1", email: "ana@example.com", roleIds: ["role-editor", "role-viewer"], invitedBy: owner });
    return { ...ctx, token: tokenOf(result.acceptUrl), invitation: result.invitation };
  }

  it("creates the membership with the invited roles and records who accepted", async () => {
    const { service, storage, token } = await invited();
    const preview = await service.preview(token);
    expect(preview).toMatchObject({ organizationName: "Acme Motors", email: "ana@example.com", roleNames: ["Editor", "Viewer"] });

    const result = await service.accept({ token, identity: invitee, verifiedEmail: " ANA@example.com" });
    expect(result.alreadyMember).toBe(false);
    expect(result.membership.roleIds.sort()).toEqual(["role-editor", "role-viewer"]);
    expect(result.invitation).toMatchObject({ status: "accepted", acceptedBy: invitee });
    expect(result.membership).toMatchObject({ status: "active", invitedBy: owner });
    expect(await storage.memberships.findByIdentity("org-1", invitee)).not.toBeNull();
    expect((await storage.auditLogs.listByOrganization("org-1")).map((e) => e.action)).toContain("invitation.accepted");
  });

  it("is single-use, and concurrent accepts produce exactly one winner", async () => {
    const { service, token } = await invited();
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) => service.accept({ token, identity: { provider: "supabase", subject: `racer-${n}` }, verifiedEmail: "ana@example.com" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(service.accept({ token, identity: invitee, verifiedEmail: "ana@example.com" })).rejects.toMatchObject({ reason: "already_accepted" });
  });

  it("refuses a verified e-mail that differs, with the same generic message as every other failure", async () => {
    const { service, token } = await invited();
    const mismatch = await service.accept({ token, identity: invitee, verifiedEmail: "eve@example.com" }).catch((e) => e);
    const unknown = await service.accept({ token: "uinv_nope", identity: invitee, verifiedEmail: "ana@example.com" }).catch((e) => e);
    expect(mismatch).toMatchObject({ reason: "email_mismatch" });
    expect(unknown).toMatchObject({ reason: "invalid" });
    expect(mismatch.message).toBe(unknown.message);
  });

  it("refuses an expired invitation", async () => {
    const { service, token, clock } = await invited();
    clock.time += 8 * 24 * 3600 * 1000;
    await expect(service.accept({ token, identity: invitee, verifiedEmail: "ana@example.com" })).rejects.toMatchObject({ reason: "expired" });
    expect(await service.preview(token)).toBeNull();
  });

  it("adds roles to an existing member instead of failing", async () => {
    const { service, storage, token } = await invited();
    await storage.memberships.create({ id: "m-existing", organizationId: "org-1", identity: invitee, roleIds: ["role-viewer"] });
    const result = await service.accept({ token, identity: invitee, verifiedEmail: "ana@example.com" });
    expect(result.alreadyMember).toBe(true);
    expect(result.membership.roleIds.sort()).toEqual(["role-editor", "role-viewer"]);
  });

  it("grants the roles that still exist, and refuses when none do", async () => {
    const first = await invited();
    await first.storage.roles.delete("role-editor");
    const partial = await first.service.accept({ token: first.token, identity: invitee, verifiedEmail: "ana@example.com" });
    expect(partial.membership.roleIds).toEqual(["role-viewer"]);

    const second = await invited();
    await second.storage.roles.delete("role-editor");
    await second.storage.roles.delete("role-viewer");
    await expect(second.service.accept({ token: second.token, identity: invitee, verifiedEmail: "ana@example.com" })).rejects.toMatchObject({ reason: "roles_unavailable" });
    expect(await second.storage.memberships.findByIdentity("org-1", invitee)).toBeNull();
  });
});

describe("organization binding (audit F-03)", () => {
  it("resend and revoke treat another organization's invitation exactly like a missing one", async () => {
    const { service, storage, clock } = await setup();
    await createOrganizationWithOwner(storage, {
      organizationId: "org-2",
      organizationName: "Other Corp",
      ownerRoleId: "role-owner-2",
      membershipId: "m-owner-2",
      ownerIdentity: { provider: "supabase", subject: "owner-2" },
    });
    const { invitation, acceptUrl } = await service.invite({ organizationId: "org-1", email: "a@b.co", roleIds: ["role-editor"], invitedBy: owner });
    clock.time += 120_000;
    const stranger = { organizationId: "org-2", invitationId: invitation.id, actor: { provider: "supabase", subject: "owner-2" } };

    await expect(service.resend(stranger)).rejects.toMatchObject({ reason: "invalid" });
    await expect(service.revoke(stranger)).rejects.toMatchObject({ reason: "invalid" });
    // untouched: the original link still works and the invitation is still pending
    expect(await service.preview(tokenOf(acceptUrl))).not.toBeNull();
    expect((await storage.invitations.findById(invitation.id))?.status).toBe("pending");
  });
});

describe("rate limits (audit F-06)", () => {
  async function manyOrgs(storage: Awaited<ReturnType<typeof setup>>["storage"], n: number) {
    for (let i = 0; i < n; i++) {
      await createOrganizationWithOwner(storage, {
        organizationId: `g${i}`,
        organizationName: `Org ${i}`,
        ownerRoleId: `go${i}`,
        membershipId: `gm${i}`,
        ownerIdentity: { provider: "x", subject: `g-owner-${i}` },
      });
      await storage.roles.create({ id: `gv${i}`, organizationId: `g${i}`, name: "Viewer", permissionKeys: [] });
    }
  }

  it("organizations an attacker controls can't exhaust a victim's quota for everybody else", async () => {
    const { service, storage } = await setup();
    await manyOrgs(storage, 6);
    for (let i = 0; i < 6; i++) {
      await service.invite({ organizationId: `g${i}`, email: "ceo@target.com", roleIds: [`gv${i}`], invitedBy: owner });
    }
    await expect(
      service.invite({ organizationId: "org-1", email: "ceo@target.com", roleIds: ["role-editor"], invitedBy: owner }),
    ).resolves.toBeDefined();
  });

  it("still enforces a global ceiling per e-mail", async () => {
    const { service, storage } = await setup({ rateLimits: { perEmailGlobalPerHour: 3 } });
    await manyOrgs(storage, 4);
    for (let i = 0; i < 3; i++) {
      await service.invite({ organizationId: `g${i}`, email: "x@target.com", roleIds: [`gv${i}`], invitedBy: owner });
    }
    await expect(
      service.invite({ organizationId: "g3", email: "x@target.com", roleIds: ["gv3"], invitedBy: owner }),
    ).rejects.toMatchObject({ reason: "rate_limited" });
  });

  it("concurrent invites can't all slip under the limit", async () => {
    const { service, storage } = await setup({ rateLimits: { perOrganizationPerHour: 5 } });
    await manyOrgs(storage, 1);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, n) =>
        service.invite({ organizationId: "org-1", email: `p${n}@x.co`, roleIds: ["role-editor"], invitedBy: owner }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  });
});

describe("audit trail (audit F-10)", () => {
  it("never stores the invitee's address in the append-only log, only a fingerprint", async () => {
    const { service, storage } = await setup();
    await service.invite({ organizationId: "org-1", email: "Ana@Example.com", roleIds: ["role-editor"], invitedBy: owner });
    const entries = await storage.auditLogs.listByOrganization("org-1");
    const created = entries.find((entry) => entry.action === "invitation.created")!;
    expect(JSON.stringify(created.metadata)).not.toContain("ana@example.com");
    expect(created.metadata?.emailFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });
});
