import { createRequire } from "node:module";
import { API_SCOPES } from "@uniora/core";
import { statusForCode } from "./errors.js";
import type { Route } from "./route.js";
import { COMPONENT_SCHEMAS } from "./routes/components.js";
import { allRoutes } from "./routes/index.js";
import { toJsonSchema } from "./schema.js";
import type { JsonSchemaObject, ObjectSchema, Schema } from "./schema.js";

type Json = Record<string, unknown>;

const TAGS: Readonly<Record<string, { name: string; description: string }>> = {
  decisions: { name: "Decisions", description: "Ask whether a user may do something. Application calls." },
  organizations: { name: "Organizations", description: "Read organizations and create them with their first Owner." },
  members: { name: "Members", description: "An organization's members and what a user may change about them." },
  roles: { name: "Roles", description: "Roles and the permissions they hold." },
  permissions: { name: "Catalog", description: "The permissions and features registered in the deployment." },
  features: { name: "Catalog", description: "The permissions and features registered in the deployment." },
  audit: { name: "Audit log", description: "The tamper-evident history of an organization." },
  teams: { name: "Teams", description: "Teams, their tree and their members." },
  teamMembers: { name: "Teams", description: "Teams, their tree and their members." },
  policies: { name: "Policies", description: "Conditional rules that restrict what roles allow." },
  invitations: { name: "Invitations", description: "Invite people, and the accept flow your server relays." },
};

/** Statuses for the codes whose status is not what their shape says. */
const STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400,
  invalid_cursor: 400,
  invalid_json: 400,
  unexpected_body: 400,
  actor_required: 400,
  identity_provider_required: 400,
  identity_provider_reserved: 400,
  forbidden: 403,
  organization_not_found: 404,
  invitation_not_found: 404,
  actor_token_unsupported: 501,
  invitations_not_configured: 501,
  idempotency_key_reused: 422,
  idempotency_in_progress: 409,
  invitation_bad_request: 400,
};

const statusOf = (route: Route, code: string): number => {
  if (code === "invalid_invitation") return route.id === "invitations.preview" ? 404 : 400;
  return STATUS[code] ?? statusForCode(code);
};

const REASONS: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  412: "Precondition Failed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  503: "Service Unavailable",
};

const problemRef = { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } };

function parametersOf(location: "path" | "query", schema: ObjectSchema | undefined): Json[] {
  if (!schema) return [];
  return Object.entries(schema.shape).map(([name, inner]) => ({
    name,
    in: location,
    required: location === "path" ? true : inner.kind !== "optional",
    schema: toJsonSchema(inner, COMPONENT_SCHEMAS),
    ...(("description" in inner && inner.description) || ("inner" in inner && "description" in (inner.inner as object) && (inner.inner as { description?: string }).description)
      ? { description: (inner as { description?: string }).description ?? (inner as { inner: { description?: string } }).inner.description }
      : {}),
  }));
}

/** The common errors every route can answer, and the ones its own list adds, grouped by status. */
function errorResponses(route: Route): Record<string, Json> {
  const byStatus = new Map<number, Set<string>>();
  const add = (status: number, code: string) => byStatus.set(status, (byStatus.get(status) ?? new Set()).add(code));
  add(401, "unauthenticated");
  add(403, "forbidden");
  add(429, "rate_limited");
  add(500, "internal_error");
  for (const code of ["overloaded", "timeout", "unavailable"]) add(503, code);
  if (route.write) add(503, "read_only");
  if (route.params || route.query || route.body || route.refine) add(400, "invalid_request");
  if (route.body) {
    add(400, "invalid_json");
    add(413, "body_too_large");
    add(415, "unsupported_media_type");
  } else {
    add(400, "unexpected_body");
  }
  if (route.delegated) {
    add(400, "actor_required");
    add(501, "actor_token_unsupported");
  }
  if (route.ifMatch) add(412, "precondition_failed");
  for (const code of route.errors) add(statusOf(route, code), code);
  if (route.ifMatch) {
    // A stale version is a 412 whatever resource it is (`membership_version_conflict`, `role_version_conflict`, ...).
    for (const code of [...(byStatus.get(412) ?? [])]) if (code === "precondition_failed") byStatus.get(412)!.delete(code);
  }

  const out: Record<string, Json> = {};
  for (const [status, codes] of [...byStatus].sort((a, b) => a[0] - b[0])) {
    if (codes.size === 0) continue;
    const list = [...codes].sort();
    out[String(status)] = {
      description: `${REASONS[status] ?? "Error"}. \`code\` is one of: ${list.map((code) => `\`${code}\``).join(", ")}.`,
      ...(status === 401 ? { headers: { "WWW-Authenticate": { schema: { type: "string" } } } } : {}),
      ...(status === 429 || status === 503 ? { headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait." } } } : {}),
      content: problemRef,
    };
  }
  return out;
}

function operation(route: Route): Json {
  const tag = TAGS[route.id.split(".")[0]!]!;
  const headers: Json[] = [];
  if (route.delegated) {
    headers.push({ $ref: "#/components/parameters/ActorSubject" }, { $ref: "#/components/parameters/ActorProvider" });
  }
  if (route.ifMatch) headers.push({ $ref: "#/components/parameters/IfMatch" });
  if (route.idempotent) headers.push({ $ref: "#/components/parameters/IdempotencyKey" });

  const successHeaders: Json = {
    ...(route.etag ? { ETag: { schema: { type: "string" }, description: "The version of the resource, quoted. Send it back as `If-Match`." } } : {}),
    ...(route.status === 201 ? { Location: { schema: { type: "string" }, description: "Where to read what was created, when it has an address." } } : {}),
    "Request-Id": { $ref: "#/components/headers/RequestId" },
  };
  const success: Json =
    route.status === 204
      ? { description: "No Content", headers: successHeaders }
      : {
          description: REASONS[route.status] ?? "OK",
          headers: successHeaders,
          content: { "application/json": { schema: toJsonSchema(route.response as Schema, COMPONENT_SCHEMAS) } },
        };

  const parameters = [...parametersOf("path", route.params), ...parametersOf("query", route.query), ...headers];
  return {
    operationId: route.id,
    tags: [tag.name],
    summary: route.summary,
    description: route.description,
    security: [{ ApiKey: [] }],
    "x-uniora-scope": route.scope,
    "x-uniora-delegated": route.delegated,
    "x-uniora-changes-data": route.write,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(route.body ? { requestBody: { required: true, content: { "application/json": { schema: toJsonSchema(route.body, COMPONENT_SCHEMAS) } } } } : {}),
    responses: { [String(route.status)]: success, ...errorResponses(route) },
  };
}

export interface OpenApiOptions {
  readonly routes?: readonly Route[];
  readonly version?: string;
}

/**
 * The OpenAPI 3.1 document of the API, generated from the same route table the server answers from: a route cannot be served
 * without being in it, and its schemas are the ones that validate the requests and shape the responses, so the document cannot
 * drift from the behaviour. `openapi.test.ts` compares it with the committed copy.
 */
export function buildOpenApiDocument(options: OpenApiOptions = {}): Json {
  const routes = options.routes ?? allRoutes();
  const version = options.version ?? (createRequire(import.meta.url)("../package.json") as { version: string }).version;

  const paths: Record<string, Record<string, Json>> = {};
  for (const route of [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
    const path = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");
    (paths[path] ??= {})[route.method.toLowerCase()] = operation(route);
  }

  const schemas: Record<string, JsonSchemaObject> = {
    Problem: {
      type: "object",
      description: "RFC 9457 `application/problem+json`. `code` is stable and only ever added; `title` is the HTTP reason phrase and never says more (no identity, organization or internal message).",
      required: ["type", "title", "status", "code", "requestId"],
      properties: {
        type: { type: "string", examples: ["urn:uniora:error:forbidden"] },
        title: { type: "string", examples: ["Forbidden"] },
        status: { type: "integer", examples: [403] },
        code: { type: "string", examples: ["forbidden"] },
        requestId: { type: "string", description: "Quote it when you ask the operator about this request: the detail is in the server's log under it.", examples: ["req_Qm0e2dIuGq1Wk8nU"] },
        errors: {
          type: "array",
          description: "On a `400 invalid_request`: where the input is wrong and why, never the value.",
          items: {
            type: "object",
            required: ["path", "code"],
            properties: { path: { type: "string", examples: ["checks[0].permission"] }, code: { type: "string", examples: ["required"] } },
          },
        },
      },
    },
  };
  for (const [schema, name] of [...COMPONENT_SCHEMAS].sort((a, b) => a[1].localeCompare(b[1]))) {
    schemas[name] = toJsonSchema(schema, new Map([...COMPONENT_SCHEMAS].filter(([, other]) => other !== name)));
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "UNIORA API",
      version,
      description:
        "Organizations, roles, permissions, teams, policies and invitations, as a service you run yourself. Your backend calls it with an API key; your auth provider stays in your project. Every call needs `Authorization: Bearer <key>`.",
      license: { name: "PolyForm-Shield-1.0.0", identifier: "PolyForm-Shield-1.0.0" },
    },
    servers: [{ url: "https://uniora.example.com", description: "Your own deployment" }],
    tags: [...new Map(Object.values(TAGS).map((tag) => [tag.name, tag])).values()],
    security: [{ ApiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        ApiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "uniora_sk_…",
          description: "An API key created in Studio or with `uniora server keys create`. Each key belongs to a client that has scopes and a list of organizations; a call outside them is refused.",
        },
      },
      headers: { RequestId: { schema: { type: "string" }, description: "Identifies this request in the server's log." } },
      parameters: {
        ActorSubject: {
          name: "Uniora-Actor-Subject",
          in: "header",
          required: true,
          schema: { type: "string", maxLength: 1500 },
          description: "Delegated calls only: the end user the call speaks for, as your auth provider knows them, percent-encoded (`encodeURIComponent`). The client needs the `actor:assert` scope. Never copy it from what the end user sent.",
        },
        ActorProvider: {
          name: "Uniora-Actor-Provider",
          in: "header",
          required: false,
          schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$" },
          description: "The opaque label of the identity provider of the actor. Omit it to use the server's default label.",
        },
        IfMatch: {
          name: "If-Match",
          in: "header",
          required: false,
          schema: { type: "string", pattern: '^(?:W/)?"\\d+"$', examples: ['"3"'] },
          description: "The `ETag` you last saw. If the resource has changed since, the answer is `412` and nothing is changed.",
        },
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
          description: "Makes a retry safe: the same key with the same request does not repeat the change and answers the first result with `replayed: true`.",
        },
      },
      schemas,
    },
    "x-uniora-scopes": Object.fromEntries(Object.entries(API_SCOPES).map(([scope, meta]) => [scope, { description: meta.description, sensitive: meta.sensitive }])),
  };
}
