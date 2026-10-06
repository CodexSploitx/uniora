import express from "express";
import {
  createAuthorizationEngine,
  createInvitationService,
  createOrganizationWithOwner,
} from "@uniora/core";
import { acceptInvitation, invitationPreview, requirePermission } from "@uniora/express";
import { applyMigrations, createSqliteStorage, openSqliteDatabase } from "@uniora/sqlite";

/**
 * Everything UNIORA needs for a small API, in one function so the test can build it over an
 * in-memory database. In your app, `db` is a file (`openSqliteDatabase("app.db")`) and `who` is whatever
 * your auth provider resolved (see the identity adapters: @uniora/supabase, @uniora/clerk, ...).
 */
export async function createApp({ db = openSqliteDatabase(":memory:"), baseUrl = "http://localhost:3000" } = {}) {
  applyMigrations(db);
  const storage = createSqliteStorage(db);
  const engine = createAuthorizationEngine(storage, { ownerRequiresRegisteredPermission: true });

  // Permissions are a catalog: register the keys your routes use.
  await storage.permissions.register({ key: "projects.read", name: "Read projects" });
  await storage.permissions.register({ key: "projects.delete", name: "Delete projects" });
  await storage.permissions.register({ key: "members.invite", name: "Invite members" });

  // No `sender` here: the invitation is created and the link is returned for you to deliver.
  // Add `sender: createSmtpInvitationSenderFromEnv()` from @uniora/mailer-smtp to e-mail it.
  const invitations = createInvitationService({ storage, acceptUrl: (token) => `${baseUrl}/invite/${token}` });

  const app = express();
  app.use(express.json());

  // Demo authentication: trust a header. NEVER do this in production, use your auth provider.
  const who = (req) => {
    const subject = req.header("x-demo-user");
    return subject ? { identity: { provider: "demo", subject }, email: req.header("x-demo-email") } : null;
  };
  const inOrg = (req) => {
    const caller = who(req);
    return caller && { identity: caller.identity, organizationId: req.params.orgId };
  };

  app.post("/orgs", async (req, res) => {
    const caller = who(req);
    if (!caller) return res.status(401).json({ error: "unauthenticated" });
    const { organization } = await createOrganizationWithOwner(storage, {
      organizationId: crypto.randomUUID(),
      organizationName: String(req.body?.name ?? ""),
      ownerRoleId: crypto.randomUUID(),
      membershipId: crypto.randomUUID(),
      ownerIdentity: caller.identity,
    });
    res.status(201).json({ id: organization.id, slug: organization.slug });
  });

  app.post("/orgs/:orgId/roles", requirePermission(engine, "members.invite", { resolve: inOrg }), async (req, res) => {
    const role = await storage.roles.create({
      id: crypto.randomUUID(),
      organizationId: req.params.orgId,
      name: String(req.body?.name ?? ""),
      permissionKeys: Array.isArray(req.body?.permissions) ? req.body.permissions : [],
    });
    res.status(201).json({ id: role.id });
  });

  app.get("/orgs/:orgId/projects", requirePermission(engine, "projects.read", { resolve: inOrg }), (_req, res) => {
    res.json({ projects: ["alpha", "beta"] });
  });

  app.delete("/orgs/:orgId/projects/:id", requirePermission(engine, "projects.delete", { resolve: inOrg }), (_req, res) => {
    res.status(204).end();
  });

  // UNIORA doesn't decide who may invite: this route does, with the guard in front of it.
  app.post("/orgs/:orgId/invitations", requirePermission(engine, "members.invite", { resolve: inOrg }), async (req, res) => {
    const caller = who(req);
    const { acceptUrl, invitation } = await invitations.invite({
      organizationId: req.params.orgId,
      email: String(req.body?.email ?? ""),
      roleIds: req.body?.roleIds ?? [],
      invitedBy: caller.identity,
    });
    res.status(201).json({ id: invitation.id, acceptUrl });
  });

  // The two public pages of the invitation flow. `verifiedEmail` must come from your auth provider.
  app.get("/invite/:token", invitationPreview(invitations, { token: (req) => req.params.token }));
  app.post(
    "/invite/:token/accept",
    acceptInvitation(invitations, {
      token: (req) => req.params.token,
      resolve: (req) => {
        const caller = who(req);
        return caller?.email ? { identity: caller.identity, verifiedEmail: caller.email } : null;
      },
    }),
  );

  // Express 5 forwards rejected promises here.
  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: "internal" });
  });

  return { app, storage, engine, invitations, close: () => db.close() };
}
