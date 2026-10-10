import Database from "better-sqlite3";
import {
  createApiCredentialService,
  createMemoryApiCredentialStorage,
  createMemoryStorage,
  createOrganizationWithOwner,
} from "@uniora/core";
import type { ApiCredentialStorage, ApiScope, UnioraStorage } from "@uniora/core";
import { Pool } from "pg";
import { applyMigrations as applyPostgresMigrations, createPostgresApiCredentialStorage, createPostgresStorage } from "@uniora/postgres";
import { applyMigrations, createSqliteApiCredentialStorage, createSqliteStorage } from "@uniora/sqlite";
import { createJsonLogger, createUnioraServer, silentLogger } from "../index.js";
import type { LogEntry, RunningServer, UnioraServerOptions } from "../index.js";

export const OPERATOR = { provider: "uniora-studio", subject: "tests" };
export const ALL_SCOPES: ApiScope[] = [
  "check",
  "organizations:read",
  "organizations:create",
  "members:write",
  "roles:write",
  "teams:write",
  "policies:write",
  "invitations:write",
  "audit:read",
  "actor:assert",
];

export type BackendName = "memory" | "sqlite" | "postgres";

/** The backends the suites run on: Postgres too when `TEST_DATABASE_URL` points at a database that may be truncated. */
export const BACKENDS: readonly BackendName[] = process.env.TEST_DATABASE_URL ? ["memory", "sqlite", "postgres"] : ["memory", "sqlite"];

let pool: Pool | undefined;
let migrated = false;
export async function closePools(): Promise<void> {
  const current = pool;
  pool = undefined;
  migrated = false;
  await current?.end();
}

export interface Backend {
  readonly storage: UnioraStorage;
  readonly credentials: ApiCredentialStorage;
  close(): void;
}

export async function createBackend(name: BackendName): Promise<Backend> {
  if (name === "postgres") {
    pool ??= new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    if (!migrated) {
      await applyPostgresMigrations(pool);
      migrated = true;
    }
    const tables = await pool.query<{ name: string }>(
      "select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname in ('uniora', 'uniora_api', 'uniora_platform') and tablename <> 'schema_migrations'",
    );
    if (tables.rows.length > 0) await pool.query(`truncate table ${tables.rows.map((row) => row.name).join(", ")} cascade`);
    return { storage: createPostgresStorage(pool), credentials: createPostgresApiCredentialStorage(pool), close() {} };
  }
  if (name === "memory") return { storage: createMemoryStorage(), credentials: createMemoryApiCredentialStorage(), close() {} };
  const db = new Database(":memory:");
  applyMigrations(db);
  return { storage: createSqliteStorage(db), credentials: createSqliteApiCredentialStorage(db), close: () => db.close() };
}

/** An organization "acme" with an owner, a viewer role with `reports.read` and two members, and one more organization "globex". */
export async function seed(storage: UnioraStorage): Promise<void> {
  for (const key of ["reports.read", "vehicles.delete", "members.roles.manage", "members.invite", "members.block", "members.remove", "roles.manage", "teams.manage", "teams.members.add", "teams.members.remove", "teams.members.manage", "policies.read", "policies.manage", "policies.activate"]) {
    await storage.permissions.register({ key });
  }
  await createOrganizationWithOwner(storage, {
    organizationId: "org_acme",
    organizationName: "Acme",
    ownerRoleId: "role_owner",
    membershipId: "mem_owner",
    ownerIdentity: { provider: "main", subject: "owner" },
  });
  await storage.roles.create({ id: "role_viewer", organizationId: "org_acme", name: "Viewer", permissionKeys: ["reports.read"] });
  await storage.roles.create({
    id: "role_manager",
    organizationId: "org_acme",
    name: "Manager",
    permissionKeys: ["members.roles.manage", "members.invite", "members.block", "members.remove", "roles.manage", "reports.read", "teams.manage", "teams.members.add", "teams.members.remove", "teams.members.manage", "policies.read", "policies.manage", "policies.activate"],
  });
  await storage.memberships.create({ id: "mem_mgr", organizationId: "org_acme", identity: { provider: "main", subject: "mgr" }, roleIds: ["role_manager"] });
  await storage.memberships.create({ id: "mem_ana", organizationId: "org_acme", identity: { provider: "main", subject: "ana" }, roleIds: ["role_viewer"] });
  await storage.memberships.create({ id: "mem_bob", organizationId: "org_acme", identity: { provider: "main", subject: "bob" } });
  await createOrganizationWithOwner(storage, {
    organizationId: "org_globex",
    organizationName: "Globex",
    ownerRoleId: "role_globex_owner",
    membershipId: "mem_globex_owner",
    ownerIdentity: { provider: "main", subject: "globex-owner" },
  });
}

export interface Fixture {
  readonly backend: Backend;
  readonly server: RunningServer;
  readonly logs: LogEntry[];
  /** Creates a client and a key; returns the key to send as `Authorization: Bearer`. */
  issue(input?: { name?: string; scopes?: ApiScope[]; organizations?: "*" | string[] }): Promise<{ token: string; clientId: string; keyId: string }>;
  call(method: string, path: string, init?: { token?: string | null; body?: unknown; raw?: string; headers?: Record<string, string>; actor?: string }): Promise<{ status: number; body: any; headers: Headers; text: string }>;
  stop(): Promise<void>;
}

let counter = 0;

export async function startFixture(
  name: BackendName,
  options: Partial<UnioraServerOptions> = {},
  wrap?: (backend: Backend) => Pick<UnioraServerOptions, "storage" | "credentials">,
): Promise<Fixture> {
  const backend = await createBackend(name);
  await seed(backend.storage);
  const logs: LogEntry[] = [];
  const service = createApiCredentialService({ storage: backend.credentials });
  const server = createUnioraServer({
    ...(wrap ? wrap(backend) : { storage: backend.storage, credentials: backend.credentials }),
    defaultProvider: "main",
    invitations: { acceptUrl: (token: string) => `https://app.test/invite/${token}`, includeAcceptUrl: true },
    logger: createJsonLogger({ minLevel: "debug", write: (line) => void logs.push(JSON.parse(line) as LogEntry) }),
    ...options,
  });
  const running = await server.listen({ port: 0 });

  const issue: Fixture["issue"] = async (input = {}) => {
    const client = await service.createClient({
      actor: OPERATOR,
      name: input.name ?? `client-${++counter}`,
      scopes: input.scopes ?? ALL_SCOPES,
      organizations: input.organizations ?? "*",
    });
    const created = await service.createKey({ actor: OPERATOR, clientId: client.id });
    return { token: created.token, clientId: client.id, keyId: created.key.id };
  };

  const call: Fixture["call"] = async (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.token !== null && init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
    if (init.actor !== undefined) headers["uniora-actor-subject"] = encodeURIComponent(init.actor);
    let body: string | undefined;
    if (init.raw !== undefined) body = init.raw;
    else if (init.body !== undefined) body = JSON.stringify(init.body);
    if (body !== undefined && !("content-type" in headers)) headers["content-type"] = "application/json";
    const response = await fetch(`${running.url}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed, headers: response.headers, text };
  };

  return {
    backend,
    server: running,
    logs,
    issue,
    call,
    async stop() {
      await running.close(1000);
      backend.close();
    },
  };
}

export { silentLogger };
