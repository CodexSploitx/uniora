import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApp } from "./app.js";

describe("express + sqlite example", () => {
  let server, base, instance;
  before(async () => {
    instance = await createApp();
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.close();
    instance.close();
  });

  const call = (path, { user, email, method = "GET", body } = {}) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(user && { "x-demo-user": user }), ...(email && { "x-demo-email": email }) },
      body: body && JSON.stringify(body),
    });

  it("walks the whole flow: create, guard, invite, accept", async () => {
    // 1. Ana creates an organization and becomes its Owner.
    const created = await call("/orgs", { user: "ana", method: "POST", body: { name: "Acme" } });
    assert.equal(created.status, 201);
    const { id: orgId } = await created.json();

    // 2. Strangers and anonymous callers are refused.
    assert.equal((await call(`/orgs/${orgId}/projects`)).status, 401);
    assert.equal((await call(`/orgs/${orgId}/projects`, { user: "stranger" })).status, 403);
    assert.equal((await call(`/orgs/${orgId}/projects`, { user: "ana" })).status, 200);

    // 3. The Owner creates a Viewer role and invites Bob with it.
    const role = await (await call(`/orgs/${orgId}/roles`, { user: "ana", method: "POST", body: { name: "Viewer", permissions: ["projects.read"] } })).json();
    const invited = await call(`/orgs/${orgId}/invitations`, { user: "ana", method: "POST", body: { email: "bob@example.com", roleIds: [role.id] } });
    assert.equal(invited.status, 201);
    const { acceptUrl } = await invited.json();
    const token = acceptUrl.split("/invite/")[1];

    // 4. Only an invited, verified address can use the link.
    assert.equal((await call(`/invite/${token}`)).status, 200);
    assert.equal((await call(`/invite/${token}/accept`, { user: "eve", email: "eve@example.com", method: "POST" })).status, 400);
    assert.equal((await call(`/invite/${token}/accept`, { user: "bob", email: "bob@example.com", method: "POST" })).status, 200);
    assert.equal((await call(`/invite/${token}/accept`, { user: "bob", email: "bob@example.com", method: "POST" })).status, 400, "a link works once");

    // 5. Bob can read but not delete, and can't invite.
    assert.equal((await call(`/orgs/${orgId}/projects`, { user: "bob" })).status, 200);
    assert.equal((await call(`/orgs/${orgId}/projects/alpha`, { user: "bob", method: "DELETE" })).status, 403);
    assert.equal((await call(`/orgs/${orgId}/invitations`, { user: "bob", method: "POST", body: { email: "x@example.com", roleIds: [role.id] } })).status, 403);

    // 6. The Owner still passes everything (the keys are registered in the catalog).
    assert.equal((await call(`/orgs/${orgId}/projects/alpha`, { user: "ana", method: "DELETE" })).status, 204);
  });
});
