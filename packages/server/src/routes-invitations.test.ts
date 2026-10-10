import { afterEach, describe, expect, it } from "vitest";
import { BACKENDS, startFixture } from "./test-support/harness.js";
import type { BackendName, Fixture } from "./test-support/harness.js";

const open: Fixture[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop();
});
async function start(name: BackendName, options?: Parameters<typeof startFixture>[1]) {
  const f = await startFixture(name, options);
  open.push(f);
  const { token } = await f.issue();
  const call = (method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; actor?: string; token?: string } = {}) => f.call(method, path, { token, ...init });
  return { f, token, call };
}
const ORG = "/v1/organizations/org_acme";
const tokenOf = (acceptUrl: string) => acceptUrl.split("/").at(-1)!;

describe.each(BACKENDS)("invitation routes over %s", (backend) => {
  it("invites, previews, accepts, and gives the roles the inviter could give", async () => {
    const { f, call } = await start(backend);
    const invited = await call("POST", `${ORG}/invitations`, { actor: "mgr", body: { email: "New.Person@Example.com", roleIds: ["role_viewer"] } });
    expect(invited.status).toBe(201);
    expect(invited.body.invitation).toMatchObject({ email: "new.person@example.com", roleIds: ["role_viewer"], status: "pending", invitedBy: { subject: "mgr" } });
    expect(invited.body.delivery).toMatchObject({ status: "skipped" });
    const token = tokenOf(invited.body.acceptUrl);

    const preview = await call("POST", "/v1/invitations/preview", { body: { token } });
    expect(preview.body).toMatchObject({ organizationName: "Acme", email: "new.person@example.com", roleNames: ["Viewer"] });

    const wrongEmail = await call("POST", "/v1/invitations/accept", { body: { token, identity: { subject: "newbie" }, verifiedEmail: "someone.else@example.com" } });
    expect(wrongEmail.status).toBe(400);
    expect(wrongEmail.body.code).toBe("invalid_invitation");

    const accepted = await call("POST", "/v1/invitations/accept", { body: { token, identity: { subject: "newbie" }, verifiedEmail: "new.person@example.com" } });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ roleIds: ["role_viewer"], rolesSkipped: [], alreadyMember: false, invitation: { status: "accepted" } });

    const check = await f.call("POST", "/v1/check", { token: (await f.issue()).token, body: { identity: { subject: "newbie" }, organizationId: "org_acme", permission: "reports.read" } });
    expect(check.body.allowed).toBe(true);

    // The link works once: now it is the same dead end as any unknown token.
    const again = await call("POST", "/v1/invitations/accept", { body: { token, identity: { subject: "newbie" }, verifiedEmail: "new.person@example.com" } });
    expect(again.body.code).toBe("invalid_invitation");
    const unknown = await call("POST", "/v1/invitations/preview", { body: { token: "x".repeat(43) } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("invalid_invitation");
  });

  it("applies the anti-escalation rules to the inviter", async () => {
    const { call } = await start(backend);
    expect((await call("POST", `${ORG}/invitations`, { actor: "mgr", body: { email: "a@example.com", roleIds: ["role_owner"] } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("POST", `${ORG}/invitations`, { actor: "ana", body: { email: "a@example.com", roleIds: ["role_viewer"] } })).body.code).toBe("forbidden");
  });

  it("makes a retry safe with an Idempotency-Key", async () => {
    const { call } = await start(backend);
    const body = { email: "retry@example.com", roleIds: ["role_viewer"] };
    const first = await call("POST", `${ORG}/invitations`, { actor: "mgr", body, headers: { "idempotency-key": "signup-42" } });
    const second = await call("POST", `${ORG}/invitations`, { actor: "mgr", body, headers: { "idempotency-key": "signup-42" } });
    expect(second.body.replayed).toBe(true);
    expect(second.body.acceptUrl).toBeNull();
    expect(second.body.invitation.id).toBe(first.body.invitation.id);
    const different = await call("POST", `${ORG}/invitations`, { actor: "mgr", body: { ...body, email: "other@example.com" }, headers: { "idempotency-key": "signup-42" } });
    expect(different.status).toBe(409);
    expect(different.body.code).toBe("invitation_idempotency_conflict");
    expect((await call("POST", `${ORG}/invitations`, { actor: "mgr", body, headers: { "idempotency-key": "bad key!" } })).status).toBe(400);
  });

  it("resends with a new link that kills the old one, and revokes", async () => {
    const { call } = await start(backend);
    const invited = await call("POST", `${ORG}/invitations`, { actor: "mgr", body: { email: "r@example.com", roleIds: ["role_viewer"] } });
    const id = invited.body.invitation.id as string;
    const resent = await call("POST", `${ORG}/invitations/${id}/resend`, { actor: "mgr", body: {} });
    expect(resent.status).toBe(200);
    const newToken = tokenOf(resent.body.acceptUrl);
    expect((await call("POST", "/v1/invitations/preview", { body: { token: tokenOf(invited.body.acceptUrl) } })).status).toBe(404);
    expect((await call("POST", "/v1/invitations/preview", { body: { token: newToken } })).status).toBe(200);

    const revoked = await call("DELETE", `${ORG}/invitations/${id}`, { actor: "mgr" });
    expect(revoked.body.status).toBe("revoked");
    expect((await call("POST", "/v1/invitations/preview", { body: { token: newToken } })).status).toBe(404);
    const cross = await call("DELETE", `/v1/organizations/org_globex/invitations/${id}`, { actor: "mgr" });
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe("invitation_not_found");
  });

  it("does not return the secret link unless the server is told to", async () => {
    const { call } = await start(backend, { invitations: { acceptUrl: (t: string) => `https://app.test/invite/${t}` } });
    const invited = await call("POST", `${ORG}/invitations`, { actor: "mgr", body: { email: "q@example.com", roleIds: ["role_viewer"] } });
    expect(invited.status).toBe(201);
    expect(invited.body.acceptUrl).toBeUndefined();
    expect(invited.text).not.toContain("app.test/invite");
  });

  it("answers 501 when invitations are not configured, and keeps the public routes to clients that reach every organization", async () => {
    const plain = await start(backend, { invitations: undefined });
    expect((await plain.call("POST", `${ORG}/invitations`, { actor: "mgr", body: { email: "a@example.com", roleIds: ["role_viewer"] } })).body.code).toBe("invitations_not_configured");
    expect((await plain.call("POST", "/v1/invitations/preview", { body: { token: "x".repeat(43) } })).status).toBe(501);

    const { f, call } = await start(backend);
    const limited = (await f.issue({ organizations: ["org_acme"] })).token;
    for (const path of ["/v1/invitations/preview", "/v1/invitations/accept"]) {
      const response = await call("POST", path, { token: limited, body: { token: "x".repeat(43), identity: { subject: "z" }, verifiedEmail: "z@example.com" } });
      expect(response.status, path).toBe(403);
    }
  });
});
