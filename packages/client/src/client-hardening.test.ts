import { afterEach, describe, expect, it } from "vitest";
import { UnioraApiError, UnioraConnectionError, createRemoteEngine, createUnioraClient } from "./index.js";

const KEY = "uniora_sk_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_cccccc";
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const problem = (status: number, code: string, headers: Record<string, string> = {}) => json(status, { type: "x", title: "x", status, code, requestId: "req_abcdef" }, headers);

function scripted(responses: (Response | Error)[], extra: Record<string, unknown> = {}) {
  const seen: { url: string }[] = [];
  const waits: number[] = [];
  const fetchStub = (async (url: string) => {
    seen.push({ url });
    const next = responses.shift();
    if (next === undefined) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const client = createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey: KEY, fetch: fetchStub, sleep: async (ms) => void waits.push(ms), ...extra });
  return { client, seen, waits };
}

describe("path parameters", () => {
  it("never lets . or .. fold the path into another operation", async () => {
    const { client, seen } = scripted([json(200, {})]);
    for (const value of [".", ".."]) {
      await expect(client.members.unassignRole({ organizationId: "o", membershipId: value, roleId: "r" }, { actor: { subject: "mgr" } })).rejects.toThrow(/not a valid id/);
      await expect(client.organizations.get({ organizationId: value })).rejects.toThrow(/not a valid id/);
    }
    expect(seen).toHaveLength(0);
    // A dot inside an id is fine, and the rest of the characters are encoded.
    await client.organizations.get({ organizationId: "a.b/..%2e" });
    expect(seen[0]!.url).toBe("https://uniora.example.com/v1/organizations/a.b%2F..%252e");
  });
});

describe("what the server says", () => {
  it("only text of the shape the server really has reaches the message", async () => {
    const { client } = scripted([json(403, { code: "x\n\u001b[31mEVIL", requestId: "req\r\nINJECT" }, { "request-id": "evil header" })]);
    const error = (await client.organizations.list({}).catch((e: unknown) => e)) as UnioraApiError;
    expect(error).toBeInstanceOf(UnioraApiError);
    expect(error.code).toBe("unexpected_response");
    expect(error.requestId).toBeUndefined();
    expect(error.message).not.toMatch(/EVIL|INJECT|\n|\u001b/);
  });

  it("keeps the shape of a real problem", async () => {
    const { client } = scripted([json(400, { code: "invalid_request", requestId: "req_Ab-1_x", errors: [{ path: "permission", code: "required" }, { path: "p", code: "not valid!" }] })]);
    const error = (await client.organizations.list({}).catch((e: unknown) => e)) as UnioraApiError;
    expect(error).toMatchObject({ code: "invalid_request", requestId: "req_Ab-1_x", issues: [{ path: "permission", code: "required" }] });
  });
});

describe("limits", () => {
  it("validates what one call asks for, so a retry loop always ends", async () => {
    const { client, seen } = scripted([problem(503, "unavailable")]);
    for (const options of [{ retries: Infinity }, { retries: "abc" }, { retries: -1 }, { retries: 99 }, { timeoutMs: NaN }, { timeoutMs: 0 }, { timeoutMs: -5 }]) {
      await expect(client.organizations.list({}, options as never)).rejects.toThrow(/must be an integer/);
    }
    expect(seen).toHaveLength(0);
  });

  it("does not retry a server in read-only mode, even for an idempotent creation, and does not wait longer than the call's time limit", async () => {
    const readOnly = scripted([problem(503, "read_only", { "retry-after": "30" }), json(201, {})]);
    await expect(readOnly.client.organizations.create({ name: "X", owner: { subject: "s" } })).rejects.toMatchObject({ code: "read_only" });
    expect(readOnly.seen).toHaveLength(1);
    const slow = scripted([problem(503, "unavailable", { "retry-after": "30" }), json(200, {})], { timeoutMs: 1000 });
    await expect(slow.client.organizations.list({})).rejects.toMatchObject({ code: "unavailable" });
    expect(slow.seen).toHaveLength(1);
  });

  it("stops waiting between retries when the caller aborts", async () => {
    const controller = new AbortController();
    let release: () => void = () => undefined;
    const { client, seen } = scripted([problem(503, "unavailable"), json(200, {})], { sleep: () => new Promise<void>((resolve) => (release = resolve)) });
    const call = client.organizations.list({}, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(call).rejects.toBeInstanceOf(UnioraConnectionError);
    expect(seen).toHaveLength(1);
    release();
  });

  it("validates the version, the idempotency key and the actor's provider before anything leaves", async () => {
    const { client, seen } = scripted([json(200, {})]);
    const input = { organizationId: "o", membershipId: "m" };
    await expect(client.members.unblock(input, { actor: { subject: "a" }, ifMatch: '1", x="2' as never })).rejects.toThrow(/version number/);
    await expect(client.members.unblock(input, { actor: { subject: "a" }, ifMatch: -1 })).rejects.toThrow(/version number/);
    await expect(client.members.unblock(input, { actor: { subject: "a", provider: "bad\r\nlabel" } })).rejects.toThrow(/valid label/);
    await expect(client.organizations.create({ name: "x", owner: { subject: "s" } }, { idempotencyKey: "bad key" })).rejects.toThrow(/idempotencyKey/);
    expect(seen).toHaveLength(0);
  });
});

describe("browsers and workers", () => {
  it("refuses a worker scope and a document as well as a window", () => {
    const g = globalThis as Record<string, unknown>;
    try {
      g.WorkerGlobalScope = class {};
      expect(() => createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey: KEY })).toThrow(/never in a browser/);
      delete g.WorkerGlobalScope;
      g.document = {};
      expect(() => createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey: KEY })).toThrow(/never in a browser/);
    } finally {
      delete g.WorkerGlobalScope;
      delete g.document;
    }
  });
});

describe("the remote engine", () => {
  const ana = { provider: "main", subject: "ana" };
  const engine = (responses: (Response | Error)[]) => {
    const { client, seen } = scripted(responses);
    return { engine: createRemoteEngine(createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey: KEY, retries: 0, fetch: (async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next!;
    }) as unknown as typeof fetch })), seen, client };
  };

  it("answers false, like the local engine, for an organization this key may not reach", async () => {
    const { engine: e } = engine([problem(404, "organization_not_found"), problem(404, "organization_not_found"), problem(404, "organization_not_found")]);
    expect(await e.can({ identity: ana, organizationId: "org_other", permission: "p" })).toBe(false);
    expect(await e.access.check({ identity: ana, organizationId: "org_other", permission: "p" })).toBe(false);
    expect(await e.authorize({ identity: ana, organizationId: "org_other", permission: "p" })).toMatchObject({ allowed: false, decision: "deny", reason: "malformed_input" });
  });

  it("lets nothing through that is not a plain true", async () => {
    const { engine: e } = engine([json(200, { allowed: "false" }), json(200, { allowed: 1 }), json(200, { allowed: true, decision: "deny", reason: "x", policyRevision: null, evaluatedAt: "2026-01-01T00:00:00Z" }), json(200, { allowed: true })]);
    expect(await e.can({ identity: ana, organizationId: "o", permission: "p" })).toBe(false);
    expect(await e.access.check({ identity: ana, organizationId: "o", permission: "p" })).toBe(false);
    expect(await e.authorize({ identity: ana, organizationId: "o", permission: "p" })).toMatchObject({ allowed: false, reason: "evaluation_error" });
    expect(await e.authorize({ identity: ana, organizationId: "o", permission: "p" })).toMatchObject({ allowed: false });
  });

  it("never throws from authorize, whatever it is given", async () => {
    const { engine: e } = engine([]);
    for (const input of [null, undefined, {}, { identity: null }, { identity: { subject: "a" }, organizationId: "o", permission: "p" }]) {
      expect(await e.authorize(input as never)).toMatchObject({ allowed: false });
    }
  });

  it("does not let the server complete a missing provider, and sends only provider and subject", async () => {
    const bodies: unknown[] = [];
    const client = createUnioraClient({ baseUrl: "https://uniora.example.com", apiKey: KEY, retries: 0, fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return json(200, { allowed: true });
    }) as unknown as typeof fetch });
    const e = createRemoteEngine(client);
    expect(await e.can({ identity: { subject: "ana" } as never, organizationId: "o", permission: "p" })).toBe(false);
    expect(await e.can({ identity: { ...ana, email: "ana@example.com" } as never, organizationId: "o", permission: "p" })).toBe(true);
    expect(bodies).toEqual([{ identity: ana, organizationId: "o", permission: "p" }]);
  });
});

afterEach(() => undefined);
